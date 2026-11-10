import test from "node:test"
import assert from "node:assert/strict"
import { effectiveToolSurface, isToolSurface, TOOL_SURFACE_TOOL_NAMES } from "./tool-surface.ts"

test("ticket225: the native tool surface keeps decisions and drops chat/read-only tools", () => {
  assert.deepEqual(TOOL_SURFACE_TOOL_NAMES.native, [
    "task_status",
    "review",
    "ask_person",
    "remember",
    "share",
  ])
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.includes("send_message"), false)
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.includes("workspace_info"), false)
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.includes("list_workspaces"), false)
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.includes("list_agents"), false)
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.includes("delegate"), false)
  assert.equal(TOOL_SURFACE_TOOL_NAMES.native.includes("handoff"), false)
})

test("ticket225: the legacy tool surface keeps the one-release rollback set", () => {
  assert.deepEqual(TOOL_SURFACE_TOOL_NAMES.legacy, [
    "workspace_info",
    "list_workspaces",
    "list_agents",
    "task_status",
    "send_message",
    "handoff",
    "delegate",
    "review",
    "ask_person",
    "remember",
    "share",
  ])
})

test("ticket225: native-first cutover selects the native surface and off/shadow keep legacy", () => {
  assert.equal(effectiveToolSurface(undefined), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "off" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "shadow" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "on" }), "native")
})

test("ticket225: an explicit setting overrides the migration mode for rollback and forward tests", () => {
  assert.equal(effectiveToolSurface({ nativeFirst: "on", toolSurface: "legacy" }), "legacy")
  assert.equal(effectiveToolSurface({ nativeFirst: "off", toolSurface: "native" }), "native")
  assert.equal(effectiveToolSurface({ nativeFirst: "shadow", toolSurface: "native" }), "native")
  assert.equal(isToolSurface("native"), true)
  assert.equal(isToolSurface("legacy"), true)
  assert.equal(isToolSurface("sometimes"), false)
})
