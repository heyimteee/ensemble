import test from "node:test"
import assert from "node:assert/strict"
import { pickerWindow, toggleSelected } from "./picker.ts"

test("picker selection toggles without mutating the source set", () => {
  const source = new Set(["nova"])
  const added = toggleSelected(source, "flint")
  assert.deepEqual([...added].sort(), ["flint", "nova"])
  assert.deepEqual([...source], ["nova"])
  const removed = toggleSelected(added, "nova")
  assert.deepEqual([...removed], ["flint"])
})

test("picker window follows the cursor and clamps at the ends", () => {
  assert.deepEqual(pickerWindow(0, 20, 8), { start: 0, end: 8 })
  assert.deepEqual(pickerWindow(10, 20, 8), { start: 6, end: 14 })
  assert.deepEqual(pickerWindow(19, 20, 8), { start: 12, end: 20 })
  assert.deepEqual(pickerWindow(0, 3, 8), { start: 0, end: 3 })
})
