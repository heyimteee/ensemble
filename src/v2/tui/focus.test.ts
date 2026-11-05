import test from "node:test"
import assert from "node:assert/strict"
import { focusWhenReady } from "./focus.ts"

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
