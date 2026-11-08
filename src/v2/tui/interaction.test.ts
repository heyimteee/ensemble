import test from "node:test"
import assert from "node:assert/strict"
import {
  caretForEditor,
  caretStyleForMode,
  initialInteractionState,
  insertWithoutTarget,
  interactionReducer,
  textTargetOf,
  visibleMessage,
  type InteractionState,
} from "./interaction.ts"

const reduce = (state: InteractionState, event: Parameters<typeof interactionReducer>[1]) => {
  const result = interactionReducer(state, event)
  return { state: result.state, intents: result.intents }
}

test("interaction starts in Normal mode on the roster with no pending surface state", () => {
  const state = initialInteractionState()
  assert.equal(state.mode, "normal")
  assert.equal(state.focus, "rail")
  assert.equal(state.overlay, "none")
  assert.equal(state.field, null)
  assert.equal(state.command, null)
  assert.equal(state.pendingChord, null)
  assert.equal(state.selection, null)
  assert.equal(state.message, null)
})

test("Insert entry focuses the composer and asks the adapter to focus the editor", () => {
  const result = reduce(initialInteractionState(), { type: "insert.enter" })
  assert.equal(result.state.mode, "insert")
  assert.equal(result.state.focus, "composer")
  assert.deepEqual(result.intents, [{ type: "focus-editor", target: "composer" }])
})

test("the Esc ladder goes Insert -> composer Normal -> chat Normal, never quitting", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" })
  const composerNormal = reduce(insert.state, { type: "escape" })
  assert.equal(composerNormal.state.mode, "normal")
  assert.equal(composerNormal.state.focus, "composer")
  assert.deepEqual(composerNormal.intents, [], "Insert -> Normal keeps the editor focused")

  const chatNormal = reduce(composerNormal.state, { type: "escape" })
  assert.equal(chatNormal.state.mode, "normal")
  assert.equal(chatNormal.state.focus, "chat")
  assert.deepEqual(chatNormal.intents, [{ type: "blur-editor" }])

  const idle = reduce(chatNormal.state, { type: "escape" })
  assert.deepEqual(idle.state, chatNormal.state, "an idle Esc changes nothing")
  assert.deepEqual(idle.intents, [{ type: "noop" }])
  assert.ok(!idle.intents.some((intent) => String(intent.type).includes("quit")), "Esc never emits a quit intent")
})

test("Esc on an idle roster surface never leaves Ensemble", () => {
  const state = initialInteractionState()
  const result = reduce(state, { type: "escape" })
  assert.deepEqual(result.state, state)
  assert.deepEqual(result.intents, [{ type: "noop" }])
})

test("Ctrl+G leaves the editor immediately from Insert or composer Normal", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" })
  const left = reduce(insert.state, { type: "leave.editor" })
  assert.equal(left.state.mode, "normal")
  assert.equal(left.state.focus, "chat")
  assert.deepEqual(left.intents, [{ type: "blur-editor" }])

  const composerNormal = reduce(insert.state, { type: "escape" })
  const leftNormal = reduce(composerNormal.state, { type: "leave.editor" })
  assert.equal(leftNormal.state.mode, "normal")
  assert.equal(leftNormal.state.focus, "chat")
})

test("focus changes outside the composer keep the current mode and blur the editor", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" })
  const rail = reduce(insert.state, { type: "focus.set", focus: "rail" })
  assert.equal(rail.state.focus, "rail")
  assert.equal(rail.state.mode, "insert", "moving focus never assigns Normal")
  assert.deepEqual(rail.intents, [{ type: "blur-editor" }])
})

test("leaving the Ensemble route resets Normal and clears every transient field", () => {
  const before = initialInteractionState({
    mode: "insert",
    focus: "settings",
    overlay: "settings",
    field: "settings",
    command: { kind: ":", text: "q", cursor: 1, returnMode: "insert" },
    pendingChord: "space",
    selection: { kind: "char", anchor: 0, cursor: 2 },
    message: { text: "pending", tone: "info", at: 1 },
  })

  const left = reduce(before, { type: "route.leave" })
  assert.equal(left.state.mode, "normal", "leaving always lands in Normal")
  assert.equal(left.state.focus, "rail", "an overlay context never survives the leave")
  assert.equal(left.state.overlay, "none")
  assert.equal(left.state.field, null)
  assert.equal(left.state.command, null)
  assert.equal(left.state.pendingChord, null)
  assert.equal(left.state.selection, null)
  assert.equal(left.state.message, null)
  assert.deepEqual(left.intents, [{ type: "blur-editor" }], "the adapter blurs every editor")
})

test("Esc returns from the work-list zone to the transcript", () => {
  const work = reduce(initialInteractionState(), { type: "focus.set", focus: "work" })
  assert.equal(work.state.focus, "work")
  assert.equal(work.state.mode, "normal")
  const chat = reduce(work.state, { type: "escape" })
  assert.equal(chat.state.focus, "chat")
  assert.equal(chat.state.mode, "normal")
})

test("ticket173: Esc returns from inline approvals to the work cards", () => {
  const approvals = reduce(initialInteractionState(), { type: "focus.set", focus: "approvals" })
  assert.equal(approvals.state.focus, "approvals")
  const work = reduce(approvals.state, { type: "escape" })
  assert.equal(work.state.focus, "work")
  assert.equal(work.state.mode, "normal")
})

test("an open dialog owns Esc first and closes via a typed intent", () => {
  const overlay = reduce(initialInteractionState(), { type: "overlay.set", overlay: "dialog" })
  assert.equal(overlay.state.overlay, "dialog")
  const closed = reduce(overlay.state, { type: "escape" })
  assert.equal(closed.state.overlay, "none")
  assert.equal(closed.state.mode, "normal")
  assert.deepEqual(closed.intents, [{ type: "close-overlay", overlay: "dialog" }])
})

test("a wizard Esc in step Normal asks the adapter to cancel the wizard", () => {
  const overlay = reduce(initialInteractionState(), { type: "overlay.set", overlay: "wizard" })
  const cancel = reduce(overlay.state, { type: "escape" })
  assert.equal(cancel.state.overlay, "wizard", "the adapter confirms the discard before closing")
  assert.equal(cancel.state.mode, "normal")
  assert.deepEqual(cancel.intents, [{ type: "wizard-cancel" }])
})

test("a wizard field Normal Esc cancels the wizard instead of stepping back", () => {
  const wizard = reduce(initialInteractionState({ overlay: "wizard" }), { type: "field.enter", target: "wizard" }).state
  const cancel = reduce(wizard, { type: "escape" })
  assert.equal(cancel.state.field, null)
  assert.equal(cancel.state.overlay, "wizard")
  assert.deepEqual(cancel.intents, [{ type: "blur-editor" }, { type: "wizard-cancel" }])
})

test("a dialog text field goes Insert -> field Normal -> cancel on the Esc ladder", () => {
  const open = reduce(initialInteractionState(), { type: "overlay.set", overlay: "dialog" })
  const focused = reduce(open.state, { type: "field.enter", target: "prompt" })
  assert.equal(focused.state.mode, "normal", "opening a field never enters Insert")
  assert.deepEqual(focused.intents, [{ type: "focus-editor", target: "prompt" }])

  const editing = reduce(focused.state, { type: "insert.enter", target: "prompt" })
  assert.equal(editing.state.mode, "insert")

  const fieldNormal = reduce(editing.state, { type: "escape" })
  assert.equal(fieldNormal.state.mode, "normal")
  assert.equal(fieldNormal.state.overlay, "dialog", "the first Esc only leaves the field")
  assert.deepEqual(fieldNormal.intents, [], "Insert -> Normal keeps the field focused")

  const cancelled = reduce(fieldNormal.state, { type: "escape" })
  assert.equal(cancelled.state.overlay, "none")
  assert.equal(cancelled.state.mode, "normal")
  assert.deepEqual(cancelled.intents, [{ type: "blur-editor" }, { type: "close-overlay", overlay: "dialog" }])
})

test("help opens and closes without changing the underlying mode or focus", () => {
  for (const focus of ["rail", "chat", "work", "composer"] as const) {
    const opened = reduce(initialInteractionState({ focus }), { type: "overlay.set", overlay: "help" })
    assert.equal(opened.state.overlay, "help")
    assert.equal(opened.state.mode, "normal", "help is a Normal-mode context")
    assert.equal(opened.state.focus, focus, "opening help keeps the underlying focus")
    const closed = reduce(opened.state, { type: "overlay.set", overlay: "none" })
    assert.equal(closed.state.overlay, "none")
    assert.equal(closed.state.mode, "normal")
    assert.equal(closed.state.focus, focus, "closing help returns to the same focus")
  }
})

test("closing a dialog keeps the mode it was opened over and clears the field", () => {
  const editing = reduce(
    reduce(initialInteractionState(), { type: "overlay.set", overlay: "dialog" }).state,
    { type: "insert.enter", target: "prompt" },
  )
  const closed = reduce(editing.state, { type: "field.leave" })
  assert.equal(closed.state.mode, "insert", "leaving a field never assigns Normal")
  assert.equal(closed.state.field, null)
  const reopened = reduce(editing.state, { type: "overlay.set", overlay: "none" })
  assert.equal(reopened.state.mode, "insert", "closing an overlay preserves the mode")
  const dismissed = reduce(editing.state, { type: "overlay.set", overlay: "help" })
  assert.equal(dismissed.state.mode, "insert", "switching overlays also preserves the mode")
})

test("a command input owns Esc before the composer ladder and closes cleanly", () => {
  const command = reduce(initialInteractionState(), { type: "command.open", kind: "/", text: "" })
  assert.deepEqual(command.state.command, { kind: "/", text: "", cursor: 0, returnMode: "normal" })
  assert.equal(command.state.mode, "command", "Command is its own mode chip")
  const updated = reduce(command.state, { type: "command.update", text: "agent" })
  assert.deepEqual(updated.state.command, { kind: "/", text: "agent", cursor: 5, returnMode: "normal" })
  const moved = reduce(updated.state, { type: "command.update", text: "agent", cursor: 2 })
  assert.deepEqual(moved.state.command, { kind: "/", text: "agent", cursor: 2, returnMode: "normal" })
  const stale = reduce(updated.state, { type: "command.update", text: "age", cursor: 99 })
  assert.equal(stale.state.command?.cursor, 3, "an out-of-range command cursor clamps to the text")
  const closed = reduce(updated.state, { type: "escape" })
  assert.equal(closed.state.command, null)
  assert.equal(closed.state.mode, "normal")
  assert.deepEqual(closed.intents, [], "a roster command restores Normal without focusing an editor")
})

test("settings text fields follow current -> field Normal -> settings Normal -> close", () => {
  const opened = reduce(initialInteractionState({ overlay: "settings", focus: "settings" }), {
    type: "settings.field.open",
  })
  assert.equal(opened.state.mode, "normal", "a field opens in the current mode")
  assert.equal(opened.state.focus, "settings")
  assert.equal(opened.state.field, "settings")
  assert.equal(opened.state.overlay, "settings")
  assert.deepEqual(opened.intents, [{ type: "focus-editor", target: "settings" }])

  const editing = reduce(opened.state, { type: "insert.enter", target: "settings" })
  const fieldNormal = reduce(editing.state, { type: "escape" })
  assert.equal(fieldNormal.state.mode, "normal")
  assert.equal(fieldNormal.state.field, "settings", "the field keeps the keyboard in field Normal")
  assert.equal(fieldNormal.state.overlay, "settings")
  assert.deepEqual(fieldNormal.intents, [], "Insert -> Normal keeps the field focused")

  const settingsNormal = reduce(fieldNormal.state, { type: "escape" })
  assert.equal(settingsNormal.state.mode, "normal")
  assert.equal(settingsNormal.state.field, null, "the second Esc returns to settings Normal")
  assert.equal(settingsNormal.state.overlay, "settings")
  assert.deepEqual(settingsNormal.intents, [{ type: "blur-editor" }])

  const closed = reduce(settingsNormal.state, { type: "escape" })
  assert.equal(closed.state.overlay, "none", "the third Esc closes settings")
  assert.deepEqual(closed.intents, [{ type: "close-overlay", overlay: "settings" }])
})

test("Ctrl+G leaves a settings field straight to settings Normal", () => {
  const opened = reduce(initialInteractionState({ overlay: "settings", focus: "settings" }), {
    type: "settings.field.open",
  })
  const left = reduce(opened.state, { type: "leave.editor" })
  assert.equal(left.state.mode, "normal")
  assert.equal(left.state.focus, "settings")
  assert.equal(left.state.field, null)
  assert.deepEqual(left.intents, [{ type: "blur-editor" }])
})

test("closing or leaving settings clears the field state", () => {
  const opened = reduce(initialInteractionState({ overlay: "settings", focus: "settings" }), {
    type: "settings.field.open",
  })
  const closed = reduce(opened.state, { type: "settings.field.close" })
  assert.equal(closed.state.mode, "normal")
  assert.equal(closed.state.field, null)
  assert.equal(closed.state.focus, "settings")
  assert.deepEqual(closed.intents, [{ type: "blur-editor" }])

  const refreshed = reduce(opened.state, { type: "overlay.set", overlay: "none" })
  assert.equal(refreshed.state.field, null, "closing the overlay never leaves a hidden field active")
})

test("pending chord, selection, and transient messages are pure state", () => {
  const chord = reduce(initialInteractionState(), { type: "chord.set", chord: "g" })
  assert.equal(chord.state.pendingChord, "g")
  assert.equal(reduce(chord.state, { type: "chord.clear" }).state.pendingChord, null)

  const selection = reduce(initialInteractionState(), {
    type: "selection.set",
    selection: { kind: "line", anchor: 0, cursor: 4 },
  })
  assert.deepEqual(selection.state.selection, { kind: "line", anchor: 0, cursor: 4 })
  assert.equal(reduce(selection.state, { type: "selection.clear" }).state.selection, null)

  const shown = reduce(initialInteractionState(), { type: "message.show", text: "Copied", tone: "success", at: 1_000 })
  assert.deepEqual(shown.state.message, { text: "Copied", tone: "success", at: 1_000 })
  assert.equal(visibleMessage(shown.state, 2_000)?.text, "Copied")
  assert.equal(visibleMessage(shown.state, 4_001), null)
  assert.equal(reduce(shown.state, { type: "message.clear" }).state.message, null)
})

test("visual mode carries the char or line selection and Esc cancels to Normal", () => {
  const composer = initialInteractionState({ focus: "composer" })
  const entered = reduce(composer, {
    type: "visual.set",
    selection: { kind: "char", anchor: 2, cursor: 6 },
  })
  assert.equal(entered.state.mode, "visual")
  assert.equal(entered.state.focus, "composer")
  assert.deepEqual(entered.state.selection, { kind: "char", anchor: 2, cursor: 6 })
  assert.deepEqual(entered.intents, [])

  const line = reduce(entered.state, {
    type: "visual.set",
    selection: { kind: "line", anchor: 0, cursor: 6 },
  })
  assert.equal(line.state.mode, "visual")
  assert.equal(line.state.selection?.kind, "line")

  const cancelled = reduce(line.state, { type: "escape" })
  assert.equal(cancelled.state.mode, "normal")
  assert.equal(cancelled.state.focus, "composer", "Visual -> Normal keeps the editor focus")
  assert.equal(cancelled.state.selection, null)
  assert.deepEqual(cancelled.intents, [], "cancelling Visual never blurs the field")
})

test("visual.leave clears the selection; Insert or Command still replace Visual", () => {
  const visual = reduce(initialInteractionState({ focus: "composer" }), {
    type: "visual.set",
    selection: { kind: "line", anchor: 0, cursor: 2 },
  }).state

  const left = reduce(visual, { type: "visual.leave" })
  assert.equal(left.state.mode, "normal")
  assert.equal(left.state.selection, null)

  const rail = reduce(visual, { type: "focus.set", focus: "rail" })
  assert.equal(rail.state.mode, "visual", "focus changes never end Visual")
  assert.deepEqual(rail.state.selection, { kind: "line", anchor: 0, cursor: 2 })

  const insert = reduce(visual, { type: "insert.enter" })
  assert.equal(insert.state.mode, "insert")
  assert.equal(insert.state.selection, null)

  const command = reduce(visual, { type: "command.open", kind: ":" })
  assert.equal(command.state.mode, "command")
  assert.equal(command.state.selection, null)
})

test("Ctrl+G leaves a wizard field by going back one step", () => {
  const wizard = reduce(initialInteractionState(), { type: "overlay.set", overlay: "wizard" }).state
  const editing = reduce(wizard, { type: "field.enter", target: "wizard" })
  const left = reduce(editing.state, { type: "leave.editor" })
  assert.equal(left.state.mode, "normal")
  assert.equal(left.state.overlay, "wizard", "the wizard stays open")
  assert.deepEqual(left.intents, [{ type: "blur-editor" }, { type: "wizard-back" }])
})

test("Ctrl+G leaves a prompt field by cancelling the prompt", () => {
  const dialog = reduce(initialInteractionState(), { type: "overlay.set", overlay: "dialog" }).state
  const editing = reduce(dialog, { type: "field.enter", target: "prompt" })
  const left = reduce(editing.state, { type: "leave.editor" })
  assert.equal(left.state.mode, "normal")
  assert.equal(left.state.overlay, "none")
  assert.deepEqual(left.intents, [{ type: "blur-editor" }, { type: "close-overlay", overlay: "dialog" }])
})

// v5.7 T2 (#92): mode is global and persistent. Focus, overlay, and field
// changes move the keyboard without assigning a mode; only explicit edit
// commands change it.
test("focus changes never assign a mode", () => {
  for (const mode of ["normal", "insert", "visual", "command"] as const) {
    const state = initialInteractionState({ mode, focus: "chat" })
    for (const focus of ["rail", "chat", "work", "composer", "settings"] as const) {
      const result = reduce(state, { type: "focus.set", focus })
      assert.equal(result.state.mode, mode, `${mode} survives a move to ${focus}`)
    }
  }
})

test("opening and closing an overlay keeps the mode and only blurs the editor", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" }).state
  const opened = reduce(insert, { type: "overlay.set", overlay: "help" })
  assert.equal(opened.state.mode, "insert", "an overlay never assigns Normal")
  assert.equal(opened.state.focus, "composer", "the underlying focus is preserved")
  assert.ok(opened.intents.some((intent) => intent.type === "blur-editor"), "leaving the editor blurs it")

  const closed = reduce(opened.state, { type: "overlay.set", overlay: "none" })
  assert.equal(closed.state.mode, "insert", "closing an overlay never assigns Normal")
})

test("closing a picker in Insert restores the composer that owned the caret", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" }).state
  const opened = reduce(insert, { type: "overlay.set", overlay: "dialog" })
  assert.equal(opened.state.overlayReturnEditor, "composer")
  const closed = reduce(opened.state, { type: "overlay.set", overlay: "none" })
  assert.equal(closed.state.focus, "composer")
  assert.equal(closed.state.field, null)
  assert.deepEqual(closed.intents, [{ type: "blur-editor" }, { type: "focus-editor", target: "composer" }])
})

test("closing a prompt in Insert returns focus after the field blurs", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" }).state
  const dialog = reduce(insert, { type: "overlay.set", overlay: "dialog" }).state
  const editing = reduce(dialog, { type: "field.enter", target: "prompt" }).state
  const left = reduce(editing, { type: "field.leave" })
  assert.deepEqual(left.intents, [{ type: "blur-editor" }])
  const closed = reduce(left.state, { type: "overlay.set", overlay: "none" })
  assert.equal(closed.state.focus, "composer")
  assert.deepEqual(closed.intents, [{ type: "blur-editor" }, { type: "focus-editor", target: "composer" }])
})

test("a confirm opened after composer focus moved still remembers the editor", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" }).state
  const moved = reduce(insert, { type: "focus.set", focus: "chat" }).state
  const opened = reduce(moved, { type: "overlay.set", overlay: "dialog", returnEditor: "composer" })
  const closed = reduce(opened.state, { type: "overlay.set", overlay: "none" })
  assert.equal(closed.state.mode, "insert", "the mode persists")
  assert.equal(closed.state.focus, "composer")
  assert.deepEqual(closed.intents, [{ type: "blur-editor" }, { type: "focus-editor", target: "composer" }])
})

test("closing an overlay in Normal keeps Normal focus semantics", () => {
  const normal = initialInteractionState({ focus: "chat" })
  const opened = reduce(normal, { type: "overlay.set", overlay: "dialog" })
  const closed = reduce(opened.state, { type: "overlay.set", overlay: "none" })
  assert.equal(closed.state.focus, "chat")
  assert.ok(!closed.intents.some((intent) => intent.type === "focus-editor"), "Normal close does not steal focus")
})

test("ticket120: repeated overlay open/close always restores the editor and leaves no overlay focus behind", () => {
  let state = reduce(initialInteractionState(), { type: "insert.enter" }).state
  for (let cycle = 0; cycle < 3; cycle++) {
    const opened = reduce(state, { type: "overlay.set", overlay: "dialog" })
    assert.equal(opened.state.overlay, "dialog", `open ${cycle + 1} owns the overlay`)
    assert.equal(opened.state.focus, "composer", `open ${cycle + 1} preserves the underlying focus`)
    const closed = reduce(opened.state, { type: "overlay.set", overlay: "none" })
    assert.equal(closed.state.overlay, "none", `close ${cycle + 1} releases the overlay`)
    assert.equal(closed.state.focus, "composer", `close ${cycle + 1} restores the editor focus`)
    assert.deepEqual(closed.intents.at(-1), { type: "focus-editor", target: "composer" }, `close ${cycle + 1} re-focuses the editor`)
    state = closed.state
  }
  const editorNormal = reduce(state, { type: "escape" }).state
  assert.equal(editorNormal.focus, "composer", "the editor stays focused in Normal")
  const column = reduce(editorNormal, { type: "escape" }).state
  assert.equal(column.focus, "chat", "the editor returns to the column afterwards")
})

test("field focus and wizard step changes keep the mode", () => {
  const insert = initialInteractionState({ mode: "insert" })
  const entered = reduce(insert, { type: "field.enter", target: "wizard" })
  assert.equal(entered.state.mode, "insert", "focusing a field never enters Insert")
  assert.equal(entered.state.field, "wizard")
  assert.deepEqual(entered.intents, [{ type: "focus-editor", target: "wizard" }])

  const listStep = reduce(entered.state, { type: "field.leave" })
  assert.equal(listStep.state.mode, "insert", "a list step keeps Insert")
  assert.equal(listStep.state.field, null)
  assert.equal(insertWithoutTarget(listStep.state), true)
  assert.deepEqual(listStep.intents, [{ type: "blur-editor" }])
})

test("Insert without a text target is detectable on every non-editor surface", () => {
  assert.equal(textTargetOf(initialInteractionState({ mode: "insert", focus: "rail" })), null)
  assert.equal(insertWithoutTarget(initialInteractionState({ mode: "insert", focus: "rail" })), true)
  assert.equal(insertWithoutTarget(initialInteractionState({ mode: "insert", focus: "chat" })), true)
  assert.equal(insertWithoutTarget(initialInteractionState({ mode: "normal", focus: "rail" })), false, "Normal never shows the notice")

  assert.equal(textTargetOf(initialInteractionState({ mode: "insert", focus: "composer" })), "composer")
  assert.equal(insertWithoutTarget(initialInteractionState({ mode: "insert", focus: "composer" })), false)
  assert.equal(textTargetOf(initialInteractionState({ mode: "insert", field: "settings" })), "settings")
  assert.equal(textTargetOf(initialInteractionState({ mode: "insert", field: "prompt" })), "prompt")
  assert.equal(textTargetOf(initialInteractionState({ mode: "insert", field: "wizard" })), "wizard")
  assert.equal(insertWithoutTarget(initialInteractionState({ mode: "insert", overlay: "wizard", field: null })), true, "a wizard list step has no text target")
})

test("Insert entry can target a settings, prompt, or wizard field", () => {
  for (const target of ["settings", "prompt", "wizard"] as const) {
    const state = initialInteractionState()
    const entered = reduce(state, { type: "insert.enter", target })
    assert.equal(entered.state.mode, "insert")
    assert.equal(entered.state.field, target)
    assert.deepEqual(entered.intents, [{ type: "focus-editor", target }])
  }
})

test("settings fields open in the current mode and Esc keeps the field focused", () => {
  const opened = reduce(initialInteractionState({ overlay: "settings", focus: "settings" }), {
    type: "settings.field.open",
  })
  assert.equal(opened.state.mode, "normal", "opening a field never enters Insert")
  assert.equal(opened.state.field, "settings")
  assert.deepEqual(opened.intents, [{ type: "focus-editor", target: "settings" }])

  const editing = reduce(opened.state, { type: "insert.enter", target: "settings" })
  const fieldNormal = reduce(editing.state, { type: "escape" })
  assert.equal(fieldNormal.state.mode, "normal")
  assert.equal(fieldNormal.state.field, "settings", "the first Esc only leaves Insert")
  assert.deepEqual(fieldNormal.intents, [], "Insert -> Normal never blurs the field")

  const settingsNormal = reduce(fieldNormal.state, { type: "escape" })
  assert.equal(settingsNormal.state.field, null, "the second Esc leaves the field")
  assert.deepEqual(settingsNormal.intents, [{ type: "blur-editor" }])
})

test("Esc from composer Insert keeps the editor focused", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" })
  const normal = reduce(insert.state, { type: "escape" })
  assert.equal(normal.state.mode, "normal")
  assert.equal(normal.state.focus, "composer")
  assert.deepEqual(normal.intents, [], "the raw handler owns keys; no blur on Insert -> Normal")
})

test("command records its return mode and restores it on close or Esc", () => {
  const insert = initialInteractionState({ mode: "insert", focus: "composer" })
  const command = reduce(insert, { type: "command.open", kind: ":", text: "" })
  assert.equal(command.state.mode, "command")
  assert.equal(command.state.command?.returnMode, "insert")
  assert.deepEqual(command.intents, [{ type: "blur-editor" }])

  const closed = reduce(command.state, { type: "command.close" })
  assert.equal(closed.state.mode, "insert", "closing restores the mode command came from")
  assert.deepEqual(closed.intents, [{ type: "focus-editor", target: "composer" }])

  const escaped = reduce(command.state, { type: "escape" })
  assert.equal(escaped.state.mode, "insert", "Esc restores the same mode")
  assert.equal(escaped.state.command, null)
})

test("Ctrl+G leaves an Insert with no editor focused by setting Normal", () => {
  const left = reduce(initialInteractionState({ mode: "insert", focus: "rail" }), { type: "leave.editor" })
  assert.equal(left.state.mode, "normal")
  assert.equal(left.state.focus, "rail")
  assert.deepEqual(left.intents, [{ type: "blur-editor" }])
})

test("focus changes keep Visual self-contained until it is explicitly left", () => {
  const visual = reduce(initialInteractionState({ mode: "visual", focus: "composer" }), {
    type: "focus.set",
    focus: "chat",
  })
  assert.equal(visual.state.mode, "visual", "focus never ends Visual")
  assert.deepEqual(visual.state.selection, null)
  assert.equal(reduce(visual.state, { type: "visual.leave" }).state.mode, "normal")
})

test("caret mapping is a non-blinking block in Normal and a non-blinking line elsewhere", () => {
  assert.deepEqual(caretStyleForMode("normal"), { style: "block", blinking: false })
  assert.deepEqual(caretStyleForMode("insert"), { style: "line", blinking: false })
  assert.deepEqual(caretStyleForMode("visual"), { style: "line", blinking: false })
  assert.deepEqual(caretStyleForMode("command"), { style: "line", blinking: false })

  assert.deepEqual(caretForEditor("normal", true), { style: "block", blinking: false })
  assert.deepEqual(caretForEditor("insert", true), { style: "line", blinking: false })
  assert.deepEqual(caretForEditor("visual", true), { style: "line", blinking: false })
  assert.deepEqual(caretForEditor("command", true), { style: "line", blinking: false })
  assert.equal(caretForEditor("normal", false), null, "an unfocused editor paints no caret")
  assert.equal(caretForEditor("insert", false), null)
})

test("focus intents address each editor type so every field can be focused directly", () => {
  const cases = [
    ["composer", { type: "insert.enter" }],
    ["settings", { type: "settings.field.open" }],
    ["prompt", { type: "field.enter", target: "prompt" }],
    ["wizard", { type: "field.enter", target: "wizard" }],
  ] as const
  for (const [target, event] of cases) {
    const result = reduce(initialInteractionState({ overlay: target === "settings" ? "settings" : target === "prompt" || target === "wizard" ? "dialog" : "none" }), event)
    const intent = result.intents.find((value) => value.type === "focus-editor")
    assert.ok(intent, `${target} emits a focus intent`)
    assert.equal((intent as { target?: string }).target ?? "composer", target)
  }
})
