import test from "node:test"
import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import { contrastText, isOpaqueColor, leaderBadge } from "./theme.ts"

const LIGHT_ACCENT = "#f2e2b0"
const DARK_ACCENT = "#1b2430"
const SURFACE = "#101010"

test("contrast text picks black on a light accent and white on a dark accent", () => {
  assert.equal(contrastText(LIGHT_ACCENT), "#000000")
  assert.equal(contrastText(DARK_ACCENT), "#ffffff")
  assert.equal(contrastText(RGBA.fromHex(LIGHT_ACCENT)), "#000000")
  assert.equal(contrastText(RGBA.fromHex(DARK_ACCENT)), "#ffffff")
})

test("the leader badge is a true cutout when the rail surface is guaranteed", () => {
  assert.deepEqual(leaderBadge(LIGHT_ACCENT, SURFACE), { background: LIGHT_ACCENT, foreground: SURFACE })
  assert.deepEqual(leaderBadge(DARK_ACCENT, SURFACE), { background: DARK_ACCENT, foreground: SURFACE })
})

test("the badge falls back to automatic black/white contrast for both accents", () => {
  assert.deepEqual(leaderBadge(LIGHT_ACCENT, null), { background: LIGHT_ACCENT, foreground: "#000000" })
  assert.deepEqual(leaderBadge(DARK_ACCENT, null), { background: DARK_ACCENT, foreground: "#ffffff" })
  assert.deepEqual(leaderBadge(LIGHT_ACCENT, "transparent"), { background: LIGHT_ACCENT, foreground: "#000000" })
  assert.deepEqual(leaderBadge(DARK_ACCENT, "transparent"), { background: DARK_ACCENT, foreground: "#ffffff" })
})
