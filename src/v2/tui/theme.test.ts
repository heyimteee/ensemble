import test from "node:test"
import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import { contrastText, isOpaqueColor, leaderBadge, opaqueSurface } from "./theme.ts"

const LIGHT_ACCENT = "#f2e2b0"
const DARK_ACCENT = "#1b2430"
const SURFACE = "#101010"

test("contrast text picks black on a light accent and white on a dark accent", () => {
  assert.equal(contrastText(LIGHT_ACCENT), "#000000")
  assert.equal(contrastText(DARK_ACCENT), "#ffffff")
  assert.equal(contrastText(RGBA.fromHex(LIGHT_ACCENT)), "#000000")
  assert.equal(contrastText(RGBA.fromHex(DARK_ACCENT)), "#ffffff")
})

test("an opaque surface prefers the detected terminal background, then the panel", () => {
  assert.equal(opaqueSurface("#1e1e1e", "#202020"), "#1e1e1e")
  assert.equal(opaqueSurface(null, "#202020"), "#202020")
  assert.equal(opaqueSurface("transparent", "#202020"), "#202020")
  assert.equal(opaqueSurface(null, "transparent"), "#101010", "the last resort is an opaque constant")
  assert.equal(opaqueSurface(RGBA.fromHex("#282828"), "#202020"), "#282828")
  assert.equal(isOpaqueColor(RGBA.defaultBackground()), false, "an unresolved terminal default is not a color")
  assert.equal(isOpaqueColor(RGBA.fromHex("#282828")), true)
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
