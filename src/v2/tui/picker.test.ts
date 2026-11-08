import test from "node:test"
import assert from "node:assert/strict"
import {
  boundSessionID,
  filterPickerCandidates,
  nativePickerCandidates,
  nativeSessionRoute,
  pickerCandidateRows,
  pickerWindow,
  stablePickerItems,
  toggleSelected,
  type NativePickerMember,
} from "./picker.ts"
import { singleChoiceValue } from "./overlays.ts"

const members: NativePickerMember[] = [
  { id: "nova", name: "Nova", title: "Engineering", leader: true, busy: true },
  { id: "flint", name: "Flint", title: "Design", leader: false, busy: false },
]

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

test("ticket174: native picker rows show name, role, leader, and busy state", () => {
  const candidates = nativePickerCandidates(members)
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["nova", "flint"])
  assert.equal(candidates[0].label, "Nova")
  assert.match(candidates[0].detail ?? "", /Engineering/)
  assert.match(candidates[0].detail ?? "", /leader/)
  assert.match(candidates[0].detail ?? "", /busy/)
  assert.match(candidates[1].detail ?? "", /Design/)
  assert.match(candidates[1].detail ?? "", /member/)
  assert.match(candidates[1].detail ?? "", /idle/)
  assert.match(nativePickerCandidates([{ ...members[0], title: "  " }])[0].detail ?? "", /no title/)
})

test("ticket174: the native filter matches name, role, leader, and busy fields", () => {
  const candidates = nativePickerCandidates(members)
  assert.deepEqual(filterPickerCandidates(candidates, "fli").map((item) => item.id), ["flint"])
  assert.deepEqual(filterPickerCandidates(candidates, "engineering").map((item) => item.id), ["nova"])
  assert.deepEqual(filterPickerCandidates(candidates, "leader").map((item) => item.id), ["nova"])
  assert.deepEqual(filterPickerCandidates(candidates, "idle").map((item) => item.id), ["flint"])
  assert.deepEqual(filterPickerCandidates(candidates, "").map((item) => item.id), ["nova", "flint"])
  assert.deepEqual(filterPickerCandidates(candidates, "zzz"), [])
})

test("ticket174: picker rows align the name column for the filtered set", () => {
  const candidates = nativePickerCandidates(members)
  const rows = pickerCandidateRows(candidates, "", { separator: "|" })
  assert.equal(rows.length, 2)
  assert.equal(rows[0].label.indexOf("|"), rows[1].label.indexOf("|"), "both separators sit in one column")
  const narrowed = pickerCandidateRows(nativePickerCandidates(members, "|"), "engineering", { separator: "|" })
  assert.equal(narrowed.length, 1)
  assert.match(narrowed[0].label, /^Nova \| Engineering \| leader \| busy$/)
})

test("ticket174: the focused native candidate is the selected workspace member", () => {
  const rows = pickerCandidateRows(nativePickerCandidates(members), "", { separator: "|" })
    .map((row) => ({ ...row, selected: false }))
  assert.equal(singleChoiceValue(rows, 0)?.id, "nova")
  assert.equal(singleChoiceValue(rows, 1)?.id, "flint")
  assert.equal(singleChoiceValue(rows, 2), undefined)
})

test("ticket174: binding lookup is workspace and agent scoped", () => {
  const bindings = {
    "w:nova": { sessionID: "s-nova" },
    "other:nova": { sessionID: "s-other" },
  }
  assert.equal(boundSessionID(bindings, "w", "nova"), "s-nova")
  assert.equal(boundSessionID(bindings, "w", "flint"), undefined, "a missing binding is explicit")
  assert.equal(boundSessionID(bindings, "other", "flint"), undefined)
})

test("ticket174: native routing follows the surface and focus", () => {
  const bindingFor = (agentID: string) => agentID === "nova" ? { sessionID: "s-nova" } : undefined
  assert.deepEqual(
    nativeSessionRoute({ surface: { kind: "agent", sessionID: "dm" }, focus: "chat", bindingFor }),
    { kind: "navigate", sessionID: "dm" },
    "a DM still opens its agent directly",
  )
  assert.deepEqual(
    nativeSessionRoute({ surface: { kind: "workspace" }, focus: "chat", bindingFor }),
    { kind: "picker" },
    "group chat asks which workspace member",
  )
  assert.deepEqual(
    nativeSessionRoute({ surface: { kind: "workspace" }, focus: "rail", bindingFor }),
    { kind: "picker" },
    "the leader menu follows the group-chat surface",
  )
  assert.deepEqual(
    nativeSessionRoute({ surface: { kind: "workspace" }, focus: "work", assignee: { id: "nova", name: "Nova" }, bindingFor }),
    { kind: "navigate", sessionID: "s-nova" },
    "Work focus keeps the focused card assignee direct",
  )
  assert.deepEqual(
    nativeSessionRoute({ surface: { kind: "agent", sessionID: "dm" }, focus: "work", bindingFor }),
    { kind: "navigate", sessionID: "dm" },
    "a DM surface wins over the focus area",
  )
})

test("ticket174: a missing binding reports a clear message instead of a no-op", () => {
  const missing = nativeSessionRoute({
    surface: { kind: "workspace" },
    focus: "work",
    assignee: { id: "flint", name: "Flint" },
    bindingFor: () => undefined,
  })
  assert.equal(missing.kind, "missing")
  assert.match(missing.message, /Flint/)
  assert.match(missing.message, /native session/i)

  const dmMissing = nativeSessionRoute({ surface: { kind: "agent", agentName: "Nova" }, focus: "chat" })
  assert.equal(dmMissing.kind, "missing")
  assert.match(dmMissing.message, /Nova/)
  assert.match(dmMissing.message, /native session/i)

  const noSurface = nativeSessionRoute({ surface: null, focus: "chat" })
  assert.equal(noSurface.kind, "missing")
  assert.match(noSurface.message, /Open a workspace or agent first/)

  const noCard = nativeSessionRoute({ surface: { kind: "workspace" }, focus: "work" })
  assert.equal(noCard.kind, "missing")
  assert.match(noCard.message, /Work card/)
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
