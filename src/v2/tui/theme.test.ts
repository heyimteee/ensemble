import test from "node:test"
import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import { contrastText } from "./theme.ts"

const LIGHT_ACCENT = "#f2e2b0"
const DARK_ACCENT = "#1b2430"

test("contrast text picks black on a light accent and white on a dark accent", () => {
  assert.equal(contrastText(LIGHT_ACCENT), "#000000")
  assert.equal(contrastText(DARK_ACCENT), "#ffffff")
  assert.equal(contrastText(RGBA.fromHex(LIGHT_ACCENT)), "#000000")
  assert.equal(contrastText(RGBA.fromHex(DARK_ACCENT)), "#ffffff")
})
