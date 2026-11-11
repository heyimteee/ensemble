import test from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_SETTINGS } from "./defaults.ts"
import { DEFAULT_NATIVE_FIRST_MODE, isNativeFirstMode, NATIVE_FIRST_MODES, nativeFirstMode } from "./native-first.ts"

test("ticket240: native-first defaults on for new settings", () => {
  assert.equal(DEFAULT_SETTINGS.nativeFirst, "on")
  assert.deepEqual(NATIVE_FIRST_MODES, ["off", "shadow", "on"])
})

test("ticket240: one canonical default constant wires the setting and the resolver", () => {
  assert.equal(DEFAULT_NATIVE_FIRST_MODE, "on")
  assert.equal(DEFAULT_SETTINGS.nativeFirst, DEFAULT_NATIVE_FIRST_MODE)
  assert.equal(nativeFirstMode(undefined), DEFAULT_NATIVE_FIRST_MODE)
  assert.equal(nativeFirstMode({ nativeFirst: "sometimes" as any }), DEFAULT_NATIVE_FIRST_MODE)
})

test("ticket240: an absent persisted mode resolves to on", () => {
  assert.equal(nativeFirstMode(undefined), "on")
  assert.equal(nativeFirstMode({}), "on")
  assert.equal(nativeFirstMode({ nativeFirst: undefined }), "on")
})

test("ticket240: an invalid persisted mode falls back to the default on", () => {
  assert.equal(nativeFirstMode({ nativeFirst: "sometimes" as any }), "on")
})

test("ticket240: explicit off and shadow keep their meaning", () => {
  assert.equal(nativeFirstMode({ nativeFirst: "off" }), "off")
  assert.equal(nativeFirstMode({ nativeFirst: "shadow" }), "shadow")
  assert.equal(nativeFirstMode({ nativeFirst: "on" }), "on")
  assert.equal(isNativeFirstMode("off"), true)
  assert.equal(isNativeFirstMode("sometimes"), false)
})
