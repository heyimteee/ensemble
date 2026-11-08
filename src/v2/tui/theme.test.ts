import test from "node:test"
import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import { contrastText, palette, workCardBorderColor } from "./theme.ts"

const LIGHT_ACCENT = "#f2e2b0"
const DARK_ACCENT = "#1b2430"

test("contrast text picks black on a light accent and white on a dark accent", () => {
  assert.equal(contrastText(LIGHT_ACCENT), "#000000")
  assert.equal(contrastText(DARK_ACCENT), "#ffffff")
  assert.equal(contrastText(RGBA.fromHex(LIGHT_ACCENT)), "#000000")
  assert.equal(contrastText(RGBA.fromHex(DARK_ACCENT)), "#ffffff")
})

function themeWithBackground(base: string): any {
  return {
    text: {
      base: base === "#fafafa" ? "#1b2430" : "#e6e6e6",
      muted: "#8a8a8a",
      faint: "#666666",
      feedback: {
        success: { base: "#4ea35a", muted: "#3c7c46" },
        warning: { base: "#d7a541", muted: "#a77f31" },
        error: { base: "#d7645b", muted: "#a34b44" },
        info: { base: "#5a91d6", muted: "#4571a7" },
      },
      action: { primary: { focused: "#ffffff" } },
    },
    border: { base: "#555555" },
    background: { base: RGBA.fromHex(base) },
    hue: { accent: { 200: "#7cc4ff", 300: "#4a8fd4" } },
  }
}

test("ticket137: the pale-blue identity token works on dark and light themes", () => {
  const dark = palette(themeWithBackground("#101010"))
  const light = palette(themeWithBackground("#fafafa"))
  assert.equal(dark.paleBlue, "#a8c7fa")
  assert.equal(light.paleBlue, "#3b6ea5")
  assert.notEqual(dark.paleBlue, light.paleBlue)
  assert.equal(palette(themeWithBackground("#101010"), "light").paleBlue, light.paleBlue, "the host theme mode wins")
  assert.equal(palette(themeWithBackground("#fafafa"), "dark").paleBlue, dark.paleBlue, "the host theme mode wins")
})

test("ticket173: focused Work cards are white and unfocused cards are grey", () => {
  const dark = palette(themeWithBackground("#101010"))
  assert.equal(dark.cardFocus, "#ffffff", "the default theme's card focus border is white")
  assert.equal(dark.border, "#555555", "unfocused cards keep the subdued border grey")
  assert.notEqual(dark.cardFocus, dark.border)
  assert.equal(workCardBorderColor(dark, true), "#ffffff")
  assert.equal(workCardBorderColor(dark, false), "#555555")
})
