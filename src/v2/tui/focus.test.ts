import test from "node:test"
import assert from "node:assert/strict"
import { focusWhenReady, halfPageCursor, nextFocusZone } from "./focus.ts"

test("focuses synchronously when the editor ref already exists", () => {
  let focused = 0
  let queued = 0
  const target = { focus: () => { focused++ } }
  const result = focusWhenReady(() => target, () => { queued++ })
  assert.equal(result, true)
  assert.equal(focused, 1)
  assert.equal(queued, 0, "an existing ref never waits for the microtask")
})

test("queues one retry for the first mount, then focuses the installed ref", () => {
  let target: { focus: () => void } | null = null
  let focused = 0
  const queue: Array<() => void> = []
  const result = focusWhenReady(() => target, (callback) => { queue.push(callback) })
  assert.equal(result, false)
  assert.equal(queue.length, 1)
  target = { focus: () => { focused++ } }
  queue[0]!()
  assert.equal(focused, 1)
})

test("a focus throw falls back to the queued retry instead of dropping the key", () => {
  let attempts = 0
  let queued = 0
  const target = {
    focus: () => {
      attempts++
      throw new Error("not mounted yet")
    },
  }
  const result = focusWhenReady(() => target, () => { queued++ })
  assert.equal(result, false)
  assert.equal(attempts, 1)
  assert.equal(queued, 1)
})

test("a missing ref stays a no-op after its queued retry", () => {
  const queue: Array<() => void> = []
  focusWhenReady(() => null, (callback) => { queue.push(callback) })
  assert.doesNotThrow(() => queue[0]!())
})

test("Tab and Shift+Tab traverse rail, chat, and the work zone in both directions", () => {
  assert.equal(nextFocusZone("rail", 1, true), "chat")
  assert.equal(nextFocusZone("chat", 1, true), "work")
  assert.equal(nextFocusZone("work", 1, true), "chat")
  assert.equal(nextFocusZone("chat", 1, false), "rail", "an unmounted work zone is skipped")

  assert.equal(nextFocusZone("rail", -1, true), "work")
  assert.equal(nextFocusZone("work", -1, true), "chat")
  assert.equal(nextFocusZone("chat", -1, true), "rail")
  assert.equal(nextFocusZone("rail", -1, false), "chat", "reverse skips the unmounted work zone")
})

test("half-page movement clamps to the list and uses at least one row", () => {
  assert.equal(halfPageCursor(0, 10, 1, 10), 5)
  assert.equal(halfPageCursor(5, 10, 1, 10), 9)
  assert.equal(halfPageCursor(9, 10, -1, 10), 4)
  assert.equal(halfPageCursor(0, 10, -1, 10), 0)
  assert.equal(halfPageCursor(3, 10, 1, 1), 4, "a one-row viewport still moves one row")
  assert.equal(halfPageCursor(3, 10, 1, 0), 4)
  assert.equal(halfPageCursor(3, 0, 1, 10), 0)
})
