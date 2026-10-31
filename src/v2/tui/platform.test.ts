import test from "node:test"
import assert from "node:assert/strict"
import { navModifier, platformBind, platformLabel } from "./platform.ts"

test("macOS uses Cmd for Ctrl bindings and labels", () => {
  assert.equal(platformBind("ctrl+shift+a", true), "super+shift+a")
  assert.equal(platformBind("pageup", true), "pageup")
  assert.equal(platformLabel("Ctrl+Shift+A", true), "Cmd+Shift+A")
  assert.equal(navModifier(true), "Cmd")
})

test("Linux and Windows keep Ctrl", () => {
  assert.equal(platformBind("ctrl+shift+a", false), "ctrl+shift+a")
  assert.equal(platformLabel("Ctrl+Shift+A", false), "Ctrl+Shift+A")
  assert.equal(navModifier(false), "Ctrl")
})
