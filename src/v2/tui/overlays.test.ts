import test from "node:test"
import assert from "node:assert/strict"
import {
  OVERLAY_PRESENCE_MS,
  OVERLAY_PRESENCE_START,
  OVERLAY_PRESENCE_STEP_MS,
  filterEdit,
  overlayPresenceKey,
  overlayPresenceOpacity,
  singleChoiceValue,
} from "./overlays.ts"

test("single-choice picker resolves the focused item", () => {
  const items = [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }]
  assert.deepEqual(singleChoiceValue(items, 0), { id: "a", label: "Alpha" })
  assert.deepEqual(singleChoiceValue(items, 1), { id: "b", label: "Beta" })
  assert.equal(singleChoiceValue(items, 2), undefined)
  assert.equal(singleChoiceValue([], 0), undefined)
})

test("inline skill filter edits the query without a dialog", () => {
  assert.deepEqual(filterEdit("", { name: "", sequence: "a" }), { query: "a", done: false, cancelled: false })
  assert.deepEqual(filterEdit("ab", { name: "backspace", sequence: "" }), { query: "a", done: false, cancelled: false })
  assert.deepEqual(filterEdit("", { name: "backspace", sequence: "" }), { query: "", done: false, cancelled: false })
  assert.deepEqual(filterEdit("ab", { name: "return", sequence: "\r" }), { query: "ab", done: true, cancelled: false })
  assert.deepEqual(filterEdit("ab", { name: "escape", sequence: "" }), { query: "ab", done: true, cancelled: true })
})

test("inline skill filter ignores modifier chords and multi-character sequences", () => {
  assert.deepEqual(filterEdit("a", { name: "", sequence: "b", ctrl: true }), { query: "a", done: false, cancelled: false })
  assert.deepEqual(filterEdit("a", { name: "", sequence: "Z?" }), { query: "a", done: false, cancelled: false })
})

test("overlay presence fades once from a quiet baseline to full opacity", () => {
  assert.ok(OVERLAY_PRESENCE_MS > 0 && OVERLAY_PRESENCE_MS <= 250, "the settle is short")
  assert.ok(OVERLAY_PRESENCE_START > 0 && OVERLAY_PRESENCE_START < 1, "the panel starts visibly faded")
  assert.ok(OVERLAY_PRESENCE_STEP_MS > 0 && OVERLAY_PRESENCE_STEP_MS < OVERLAY_PRESENCE_MS, "the interval samples the settle")

  assert.equal(overlayPresenceOpacity(0, {}), OVERLAY_PRESENCE_START)
  let previous = OVERLAY_PRESENCE_START
  for (let elapsed = OVERLAY_PRESENCE_STEP_MS; elapsed < OVERLAY_PRESENCE_MS; elapsed += OVERLAY_PRESENCE_STEP_MS) {
    const current = overlayPresenceOpacity(elapsed, {})
    assert.ok(current >= previous, `opacity never moves backwards at ${elapsed}ms`)
    assert.ok(current < 1, `opacity is still settling at ${elapsed}ms`)
    previous = current
  }
  assert.equal(overlayPresenceOpacity(OVERLAY_PRESENCE_MS, {}), 1)
  assert.equal(overlayPresenceOpacity(OVERLAY_PRESENCE_MS + 1, {}), 1, "the settle ends, it does not loop")
  assert.equal(overlayPresenceOpacity(OVERLAY_PRESENCE_MS * 100, {}), 1, "later ticks hold the final state")
})

test("overlay presence mounts at the final state under reduced motion", () => {
  assert.equal(overlayPresenceOpacity(0, { ENSEMBLE_REDUCED_MOTION: "1" }), 1)
  assert.equal(overlayPresenceOpacity(0, { ENSEMBLE_REDUCED_MOTION: "true" }), 1)
  assert.equal(overlayPresenceOpacity(0, { NO_COLOR: "1" }), 1)
  assert.equal(overlayPresenceOpacity(0, {}), OVERLAY_PRESENCE_START)
})

test("overlay presence treats negative and non-finite elapsed time as the mount frame", () => {
  assert.equal(overlayPresenceOpacity(-50, {}), OVERLAY_PRESENCE_START)
  assert.equal(overlayPresenceOpacity(Number.NaN, {}), OVERLAY_PRESENCE_START)
  assert.equal(overlayPresenceOpacity(Number.POSITIVE_INFINITY, {}), 1)
})

test("ticket126: presence keys cover help and leader which-key without changing dialog precedence", () => {
  const closed = {
    picker: false,
    prompt: false,
    confirm: false,
    result: false,
    wizard: false,
    logs: false,
    help: false,
    leader: false,
  }
  assert.equal(overlayPresenceKey(closed), "none")
  assert.equal(overlayPresenceKey({ ...closed, logs: true }), "logs")
  assert.equal(overlayPresenceKey({ ...closed, help: true }), "help")
  assert.equal(overlayPresenceKey({ ...closed, leader: true }), "leader")
  assert.equal(
    overlayPresenceKey({ ...closed, help: true, leader: true }),
    "help",
    "the surface rendered first owns the settle",
  )
  assert.equal(
    overlayPresenceKey({ ...closed, picker: true, help: true }),
    "picker",
    "a dialog panel keeps precedence over the help surface",
  )
  assert.equal(
    overlayPresenceKey({ ...closed, wizard: true, help: true }),
    "wizard",
    "the wizard keeps precedence over the help surface",
  )
})
