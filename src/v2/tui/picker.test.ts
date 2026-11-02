import test from "node:test"
import assert from "node:assert/strict"
import { pickerWindow, stablePickerItems, toggleSelected } from "./picker.ts"

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

test("review fix: picker rows keep identity when values are unchanged", () => {
  const first = [{ id: "a", label: "Alpha", selected: false }]
  // Same values, new array: the previous reference wins (no re-render).
  assert.equal(stablePickerItems(first, [{ id: "a", label: "Alpha", selected: false }]), first)
  // Any value change (order, label, selection, length) returns the new rows.
  assert.notEqual(stablePickerItems(first, [{ id: "a", label: "Alpha", selected: true }]), first)
  assert.notEqual(stablePickerItems(first, [{ id: "a", label: "Beta", selected: false }]), first)
  assert.notEqual(stablePickerItems(first, []), first)
  assert.notEqual(stablePickerItems([], [{ id: "a", label: "Alpha", selected: false }]), first)
  assert.notEqual(
    stablePickerItems(
      [{ id: "a", label: "Alpha", selected: false }, { id: "b", label: "Beta", selected: false }],
      [{ id: "b", label: "Beta", selected: false }, { id: "a", label: "Alpha", selected: false }],
    ),
    first,
  )
})
