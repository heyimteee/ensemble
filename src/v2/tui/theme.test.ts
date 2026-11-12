import test from "node:test"
import assert from "node:assert/strict"
import { RGBA } from "@opentui/core"
import {
  PALETTE_TEXT_ROLES,
  PALETTE_UI_ROLES,
  WCAG_AA_TEXT,
  WCAG_AA_UI,
  contrastRatio,
  contrastText,
  meetsContrast,
  palette,
  workCardBorderColor,
  type Palette,
} from "./theme.ts"

const LIGHT_ACCENT = "#f2e2b0"
const DARK_ACCENT = "#1b2430"

test("contrast text picks black on a light accent and white on a dark accent", () => {
  assert.equal(contrastText(LIGHT_ACCENT), "#000000")
  assert.equal(contrastText(DARK_ACCENT), "#ffffff")
  assert.equal(contrastText(RGBA.fromHex(LIGHT_ACCENT)), "#000000")
  assert.equal(contrastText(RGBA.fromHex(DARK_ACCENT)), "#ffffff")
})

function themeWithBackground(base: string): any {
  const light = base === "#fafafa"
  return {
    text: {
      base: light ? "#1b2430" : "#e6e6e6",
      muted: light ? "#5f5f5f" : "#a0a0a0",
      faint: light ? "#6b6b6b" : "#8a8a8a",
      feedback: {
        success: { base: light ? "#2f7a3a" : "#4ea35a", muted: light ? "#2f7a3a" : "#3c7c46" },
        warning: { base: light ? "#8a6415" : "#d7a541", muted: light ? "#8a6415" : "#a77f31" },
        error: { base: light ? "#b23b34" : "#d7645b", muted: light ? "#b23b34" : "#a34b44" },
        info: { base: light ? "#2f5f9e" : "#5a91d6", muted: light ? "#2f5f9e" : "#4571a7" },
      },
      action: { primary: { focused: "#ffffff" } },
    },
    border: { base: light ? "#767676" : "#6a6a6a" },
    background: { base: RGBA.fromHex(base) },
    hue: { accent: { 200: light ? "#2f6db5" : "#7cc4ff", 300: light ? "#3b6ea5" : "#4a8fd4" } },
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
  assert.equal(dark.border, "#6a6a6a", "unfocused cards keep the subdued border grey")
  assert.notEqual(dark.cardFocus, dark.border)
  assert.equal(workCardBorderColor(dark, true), "#ffffff")
  assert.equal(workCardBorderColor(dark, false), "#6a6a6a")
})

test("ticket173: card focus is the highest-contrast tone, not the host action fill", () => {
  // The live default theme's `text.action.primary.focused` is the dark fill of
  // a filled action chip, not readable text. The card border must stay the
  // high-contrast focus tone on both sides of the theme mode.
  const darkTheme = themeWithBackground("#101010")
  darkTheme.text.action.primary.focused = "#080808"
  const dark = palette(darkTheme)
  assert.equal(dark.cardFocus, "#ffffff", "a dark host surface keeps the white focus border")
  const lightTheme = themeWithBackground("#fafafa")
  lightTheme.text.action.primary.focused = "#080808"
  const light = palette(lightTheme)
  assert.equal(light.cardFocus, "#000000", "a light host surface uses the highest-contrast dark tone")
  assert.equal(workCardBorderColor(light, false), "#767676", "unfocused cards keep the grey border")
})

type MatrixThemeOptions = {
  base: string
  raised?: string
  text: string
  muted: string
  faint: string
  good: string
  warn: string
  bad: string
  info: string
  border: string
  accent: string
  leader: string
}

type MatrixTheme = {
  name: string
  mode?: "dark" | "light"
  theme: any
}

/** A complete host theme fixture for one row of the palette matrix. */
function matrixTheme(name: string, options: MatrixThemeOptions, mode?: "dark" | "light"): MatrixTheme {
  return {
    name,
    mode,
    theme: {
      text: {
        base: options.text,
        muted: options.muted,
        faint: options.faint,
        feedback: {
          success: { base: options.good, muted: options.good },
          warning: { base: options.warn, muted: options.warn },
          error: { base: options.bad, muted: options.bad },
          info: { base: options.info, muted: options.info },
        },
        action: { primary: { focused: options.text } },
      },
      border: { base: options.border },
      background: {
        base: RGBA.fromHex(options.base),
        ...(options.raised ? { raised: { base: RGBA.fromHex(options.raised) } } : {}),
      },
      hue: { accent: { 200: options.accent, 300: options.leader } },
    },
  }
}

/**
 * Ticket #259: the table is the accessibility contract for the palette. Dark,
 * light, and custom raised surfaces all map through the same `palette()` seam;
 * every text role is checked at WCAG AA 4.5:1 and every UI role at 3:1 against
 * the surface it is actually painted on.
 */
const PALETTE_MATRIX: readonly MatrixTheme[] = [
  matrixTheme(
    "dark",
    {
      base: "#101010",
      text: "#e6e6e6",
      muted: "#a0a0a0",
      faint: "#8a8a8a",
      good: "#4ea35a",
      warn: "#d7a541",
      bad: "#d7645b",
      info: "#5a91d6",
      border: "#6a6a6a",
      accent: "#7cc4ff",
      leader: "#4a8fd4",
    },
    "dark",
  ),
  matrixTheme(
    "light",
    {
      base: "#fafafa",
      text: "#1b2430",
      muted: "#5f5f5f",
      faint: "#6b6b6b",
      good: "#2f7a3a",
      warn: "#8a6415",
      bad: "#b23b34",
      info: "#2f5f9e",
      border: "#767676",
      accent: "#2f6db5",
      leader: "#3b6ea5",
    },
    "light",
  ),
  matrixTheme(
    "custom raised dark",
    {
      base: "#101010",
      raised: "#20242c",
      text: "#e8e8e8",
      muted: "#a8a8a8",
      faint: "#909090",
      good: "#6fcf7a",
      warn: "#e6b450",
      bad: "#f26d78",
      info: "#59c2ff",
      border: "#7a7a7a",
      accent: "#9cc7ff",
      leader: "#8ab4f8",
    },
  ),
  matrixTheme(
    "custom raised light",
    {
      base: "#fafafa",
      raised: "#f4f4f4",
      text: "#202020",
      muted: "#5a5a5a",
      faint: "#666666",
      good: "#2f6f3a",
      warn: "#7a5a12",
      bad: "#a8322c",
      info: "#2b5b99",
      border: "#777777",
      accent: "#2f6db5",
      leader: "#3b6ea5",
    },
  ),
]

test("ticket259: contrast ratio follows the WCAG formula and is order-independent", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21)
  assert.equal(contrastRatio("#ffffff", "#000000"), 21, "the lighter color is always the numerator")
  assert.equal(contrastRatio("#000000", "#000000"), 1)
  assert.ok(Math.abs((contrastRatio("#777777", "#ffffff") ?? 0) - 4.48) < 0.01, "the WCAG #777 example is 4.48:1")
  assert.equal(contrastRatio("transparent", "#000000"), null, "a non-color cannot claim contrast")
  assert.equal(contrastRatio(RGBA.fromValues(1, 1, 1, 0.5), "#000000"), null, "a translucent color has no single ratio")
  assert.equal(contrastRatio(RGBA.fromHex("#777777"), RGBA.fromHex("#ffffff")), contrastRatio("#777777", "#ffffff"))
})

test("ticket259: WCAG AA text and UI thresholds are applied separately", () => {
  assert.equal(WCAG_AA_TEXT, 4.5)
  assert.equal(WCAG_AA_UI, 3)
  assert.equal(meetsContrast("#777777", "#ffffff", "text"), false, "4.48 is below 4.5 for text")
  assert.equal(meetsContrast("#767676", "#ffffff", "text"), true, "4.54 is above 4.5 for text")
  assert.equal(meetsContrast("#777777", "#ffffff", "ui"), true, "4.48 is above 3 for UI")
  assert.equal(meetsContrast("transparent", "#ffffff", "ui"), false)
})

test("ticket259: every text role meets 4.5:1 on every matrix surface", () => {
  for (const row of PALETTE_MATRIX) {
    const colors = palette(row.theme, row.mode)
    for (const background of ["panel", "bg"] as const) {
      for (const role of PALETTE_TEXT_ROLES) {
        const ratio = contrastRatio(colors[role], colors[background])
        assert.ok(
          ratio !== null && ratio >= WCAG_AA_TEXT,
          `${row.name}: ${role} on ${background} is ${ratio?.toFixed(2) ?? "unknown"}:1 (need ${WCAG_AA_TEXT})`,
        )
      }
    }
  }
})

test("ticket259: every UI role meets 3:1 on the card surface", () => {
  for (const row of PALETTE_MATRIX) {
    const colors = palette(row.theme, row.mode)
    for (const role of PALETTE_UI_ROLES) {
      const ratio = contrastRatio(colors[role], colors.panel)
      assert.ok(
        ratio !== null && ratio >= WCAG_AA_UI,
        `${row.name}: ${role} on panel is ${ratio?.toFixed(2) ?? "unknown"}:1 (need ${WCAG_AA_UI})`,
      )
    }
  }
})

test("ticket259: every palette color role is classified by the contrast matrix", () => {
  const classified = new Set<string>([...PALETTE_TEXT_ROLES, ...PALETTE_UI_ROLES, "panel", "bg", "categorical"])
  const colors: Palette = palette(PALETTE_MATRIX[0].theme, PALETTE_MATRIX[0].mode)
  for (const role of Object.keys(colors)) {
    assert.ok(classified.has(role), `${role} must be a text role, a UI role, or an explicit surface/data role`)
  }
})

test("ticket259: automatic chip text keeps readable contrast on every matrix surface", () => {
  for (const row of PALETTE_MATRIX) {
    const colors = palette(row.theme, row.mode)
    const chipText = contrastText(colors.panel)
    const ratio = contrastRatio(chipText, colors.panel)
    assert.ok(ratio !== null && ratio >= WCAG_AA_TEXT, `${row.name}: chip text is ${ratio?.toFixed(2) ?? "unknown"}:1`)
  }
})
