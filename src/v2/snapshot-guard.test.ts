import test from "node:test"
import assert from "node:assert/strict"
import { shouldApplySnapshot } from "./snapshot-guard.ts"

test("the first snapshot always applies", () => {
  assert.equal(shouldApplySnapshot(undefined, 0), true)
})

test("newer and equal versions apply", () => {
  assert.equal(shouldApplySnapshot(3, 4), true)
  assert.equal(shouldApplySnapshot(3, 3), true)
})

test("an older snapshot response never repaints newer state", () => {
  assert.equal(shouldApplySnapshot(4, 3), false)
  assert.equal(shouldApplySnapshot(10, 0), false)
})
