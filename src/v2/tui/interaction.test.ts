import test from "node:test"
import assert from "node:assert/strict"
import {
  initialInteractionState,
  interactionReducer,
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
  assert.equal(state.command, null)
  assert.equal(state.pendingChord, null)
  assert.equal(state.selection, null)
  assert.equal(state.message, null)
})

test("Insert entry focuses the composer and asks the adapter to focus the editor", () => {
  const result = reduce(initialInteractionState(), { type: "insert.enter" })
  assert.equal(result.state.mode, "insert")
  assert.equal(result.state.focus, "composer")
  assert.deepEqual(result.intents, [{ type: "focus-editor" }])
})

test("the Esc ladder goes Insert -> composer Normal -> chat Normal, never quitting", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" })
  const composerNormal = reduce(insert.state, { type: "escape" })
  assert.equal(composerNormal.state.mode, "normal")
  assert.equal(composerNormal.state.focus, "composer")
  assert.deepEqual(composerNormal.intents, [{ type: "blur-editor" }])

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

test("focus changes outside the composer return to Normal mode", () => {
  const insert = reduce(initialInteractionState(), { type: "insert.enter" })
  const rail = reduce(insert.state, { type: "focus.set", focus: "rail" })
  assert.equal(rail.state.focus, "rail")
  assert.equal(rail.state.mode, "normal")
  assert.deepEqual(rail.intents, [{ type: "blur-editor" }])
})

test("Esc returns from the work-list zone to the transcript", () => {
  const work = reduce(initialInteractionState(), { type: "focus.set", focus: "work" })
  assert.equal(work.state.focus, "work")
  assert.equal(work.state.mode, "normal")
  const chat = reduce(work.state, { type: "escape" })
  assert.equal(chat.state.focus, "chat")
  assert.equal(chat.state.mode, "normal")
})

test("an open overlay owns Esc first and closes via a typed intent", () => {
  const overlay = reduce(initialInteractionState(), { type: "overlay.set", overlay: "wizard" })
  assert.equal(overlay.state.overlay, "wizard")
  const closed = reduce(overlay.state, { type: "escape" })
  assert.equal(closed.state.overlay, "none")
  assert.equal(closed.state.mode, "normal")
  assert.deepEqual(closed.intents, [{ type: "close-overlay", overlay: "wizard" }])
})

test("a command input owns Esc before the composer ladder and closes cleanly", () => {
  const command = reduce(initialInteractionState(), { type: "command.open", kind: "/", text: "" })
  assert.deepEqual(command.state.command, { kind: "/", text: "" })
  assert.equal(command.state.mode, "normal")
  const updated = reduce(command.state, { type: "command.update", text: "agent" })
  assert.deepEqual(updated.state.command, { kind: "/", text: "agent" })
  const closed = reduce(updated.state, { type: "escape" })
  assert.equal(closed.state.command, null)
  assert.deepEqual(closed.intents, [{ type: "blur-editor" }])
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
