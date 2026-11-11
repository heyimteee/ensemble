import test from "node:test"
import assert from "node:assert/strict"
import { TOOL_SURFACE_TOOL_NAMES, effectiveToolSurface, isToolSurface } from "./tool-surface.ts"

test("ticket250: the native surface has six tools and the legacy surface keeps eleven", () => {
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.length, 6)
  assert.equal(TOOL_SURFACE_TOOL_NAMES.legacy.length, 11)
  assert.ok(TOOL_SURFACE_TOOL_NAMES.native.includes("dispatch"))
  assert.ok(!TOOL_SURFACE_TOOL_NAMES.legacy.includes("dispatch"))
})

test("ticket240: the default native-first mode selects the native surface", () => {
  assert.equal(effectiveToolSurface(undefined), "native")
  assert.equal(effectiveToolSurface({}), "native")
  assert.equal(effectiveToolSurface({ nativeFirst: "on" }), "native")
})

test("ticket240: off and shadow always select the legacy surface", () => {
  assert.equal(effectiveToolSurface({ nativeFirst: "off" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "shadow" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "off", toolSurface: "native" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "shadow", toolSurface: "native" }), "legacy")
})

test("ticket221: the mention-routing kill switch selects the explicit tool surface", () => {
  assert.equal(effectiveToolSurface({ nativeFirst: "on", nativeMentionRouting: false }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "on", nativeMentionRouting: true }), "native")
})

test("ticket240: an explicit legacy tool surface rolls back while native-first stays on", () => {
  assert.equal(effectiveToolSurface({ nativeFirst: "on", toolSurface: "legacy" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "on", toolSurface: "native" }), "native")
  assert.equal(isToolSurface("native"), true)
  assert.equal(isToolSurface("legacy"), true)
  assert.equal(isToolSurface("sometimes"), false)
})
