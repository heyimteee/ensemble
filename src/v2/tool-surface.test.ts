import test from "node:test"
import assert from "node:assert/strict"
import { effectiveToolSurface, isToolSurface } from "./tool-surface.ts"

test("ticket225: native-first cutover selects the native surface and off/shadow keep legacy", () => {
  assert.equal(effectiveToolSurface(undefined), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "off" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "shadow" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "on" }), "native")
})

test("ticket221: the mention-routing kill switch selects the explicit tool surface", () => {
  assert.equal(effectiveToolSurface({ nativeFirst: "on", nativeMentionRouting: false }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "on", nativeMentionRouting: true }), "native")
})

test("ticket225: an explicit setting overrides the migration mode for rollback and forward tests", () => {
  assert.equal(effectiveToolSurface({ nativeFirst: "on", toolSurface: "legacy" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "off", toolSurface: "native" }), "native")
  assert.equal(effectiveToolSurface({ nativeFirst: "shadow", toolSurface: "native" }), "native")
  assert.equal(isToolSurface("native"), true)
  assert.equal(isToolSurface("legacy"), true)
  assert.equal(isToolSurface("sometimes"), false)
})
