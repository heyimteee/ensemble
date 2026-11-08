import test from "node:test"
import assert from "node:assert/strict"
import { DISPATCH_LIMIT_DEFAULTS, DISPATCH_MIN_GROUP_HOPS, dispatchLimitSettings, dispatchLimits } from "../dispatch-budget.ts"
import {
  LIMITS_ROW_IDS,
  cycleLimitsValue,
  limitsPanelFooter,
  limitsPanelRows,
  limitsPanelSubtitle,
  limitsPanelTitle,
  limitsRowField,
  limitsRowValue,
  limitsSave,
  limitsSavedMessage,
} from "./limits.ts"

const defaults = dispatchLimitSettings(DISPATCH_LIMIT_DEFAULTS)

test("ticket160: the limits panel reads the four settings rows in order", () => {
  const limits = dispatchLimits(defaults)
  const rows = limitsPanelRows(limits, 0)
  assert.deepEqual(rows.map((row) => row.id), [...LIMITS_ROW_IDS])
  assert.deepEqual(rows.map((row) => row.value), ["8", "24", "8", "2"])
  assert.deepEqual(rows.map((row) => row.label), ["Group hops", "Command hops", "Depth", "Continuations"])
  assert.equal(rows[0]?.text, "› Group hops      8   8 · 16 · 24")
  assert.equal(rows[1]?.text, "  Command hops    24  8 · 16 · 24 · 32 · 40 · 48")
  assert.equal(rows[2]?.text, "  Depth           8   1–16")
  assert.equal(rows[3]?.text, `  Continuations   2   0–5 · ${DISPATCH_MIN_GROUP_HOPS}-hop groups`)
  assert.equal(limitsPanelRows(limits, 9)[3]?.selected, true, "the cursor clamps")
  assert.equal(limitsRowField("continuations"), "continuations")
  assert.equal(limitsRowValue(limits, "command"), 24)
})

test("ticket160: panel rows cycle allowed tiers and numeric bounds", () => {
  let limits = dispatchLimits(defaults)
  limits = cycleLimitsValue(limits, "group", 1)
  assert.equal(limits.groupMaxHops, 16)
  limits = cycleLimitsValue(limits, "group", -1)
  assert.equal(limits.groupMaxHops, 8)
  limits = cycleLimitsValue(limits, "command", 1)
  assert.equal(limits.commandMaxHops, 32)
  limits = cycleLimitsValue(limits, "depth", 1)
  assert.equal(limits.depth, 9)
  limits = cycleLimitsValue(limits, "continuations", -1)
  assert.equal(limits.continuations, 1)
  for (let index = 0; index < 10; index++) limits = cycleLimitsValue(limits, "continuations", -1)
  assert.equal(limits.continuations, 0, "continuations clamp at the floor")
})

test("ticket160: save produces the settings patch or the first actionable error", () => {
  const ok = limitsSave(dispatchLimits(defaults))
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok ? ok.patch : undefined, defaults)
  assert.equal(
    limitsSavedMessage(dispatchLimits(defaults)),
    "Saved dispatch limits: group 8 · command 24 · depth 8 · continuations 2.",
  )

  const below = limitsSave({ groupMaxHops: 16, commandMaxHops: 8, depth: 8, continuations: 0 })
  assert.equal(below.ok, false)
  assert.match(below.ok ? "" : below.error, /Command hops \(8\) must be at least group hops \(16\)/)

  const unfit = limitsSave({ groupMaxHops: 16, commandMaxHops: 24, depth: 8, continuations: 2 })
  assert.equal(unfit.ok, false)
  assert.match(unfit.ok ? "" : unfit.error, /need at least 32 command hops/)

  const badTier = limitsSave({ groupMaxHops: 12, commandMaxHops: 24, depth: 8, continuations: 0 })
  assert.equal(badTier.ok, false)
  assert.match(badTier.ok ? "" : badTier.error, /Group hops must be one of 8, 16, 24/)
})

test("ticket160: panel chrome names the scope, new-command rule, and keys", () => {
  assert.equal(limitsPanelTitle("site"), "Dispatch limits — #site")
  assert.equal(limitsPanelTitle(), "Dispatch limits")
  assert.match(limitsPanelSubtitle(), /new commands only/)
  assert.match(limitsPanelFooter(), /enter save/)
})
