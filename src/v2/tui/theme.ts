import { RGBA } from "@opentui/core"

export type Palette = {
  accent: RGBA | string
  /** Ticket #137: stable pale-blue agent identity, readable on dark and light themes. */
  paleBlue: RGBA | string
  info: RGBA | string
  muted: RGBA | string
  faint: RGBA | string
  good: RGBA | string
  warn: RGBA | string
  bad: RGBA | string
  text: RGBA | string
  leader: RGBA | string
  border: RGBA | string
  /** Ticket #173: the focused Work card border, distinct from pane focus. */
  cardFocus: RGBA | string
  panel: RGBA | string
  focus: RGBA | string
  categorical: readonly any[]
  bg: RGBA | string
}

/**
 * Ticket #259: WCAG AA thresholds. Text roles need 4.5:1; large text and
 * non-text UI roles need 3:1. The palette matrix in theme.test.ts classifies
 * every role so a new color cannot escape the accessibility contract.
 */
export const WCAG_AA_TEXT = 4.5
export const WCAG_AA_UI = 3

/** Palette roles painted as text; each must meet WCAG AA 4.5:1. */
export const PALETTE_TEXT_ROLES = [
  "text",
  "muted",
  "faint",
  "good",
  "warn",
  "bad",
  "info",
  "paleBlue",
  "leader",
  "accent",
] as const satisfies readonly (keyof Palette)[]

/** Palette roles painted as borders or focus chrome; each must meet WCAG AA 3:1. */
export const PALETTE_UI_ROLES = ["border", "cardFocus", "focus"] as const satisfies readonly (keyof Palette)[]

const PALE_BLUE_DARK = "#a8c7fa"
const PALE_BLUE_LIGHT = "#3b6ea5"

export function palette(theme: {
  text: {
    base: RGBA
    muted: RGBA
    faint: RGBA
    feedback: Record<"success" | "warning" | "error" | "info", { base: RGBA; muted: RGBA }>
    action: { primary: { focused: RGBA } }
  }
  border: { base: RGBA }
  background?: { base: RGBA; raised?: { base: RGBA; high?: RGBA } }
  hue: { accent: Record<number, RGBA> }
}, mode?: "dark" | "light"): Palette {
  const background = (theme as any).background?.raised?.base ?? (theme as any).background?.base
  const panel = background && typeof background === "object" && background.a >= 1 ? background : "#101010"
  // Ticket #137: the host's theme mode is authoritative; fall back to the
  // background luminance so custom themes still get a readable pale blue.
  const backgroundLuminance = relativeLuminance(panel)
  const light = mode ? mode === "light" : backgroundLuminance !== null && backgroundLuminance > 0.5
  return {
    accent: (theme as any).hue?.accent?.[200] ?? theme.text.feedback.info.base,
    paleBlue: light ? PALE_BLUE_LIGHT : PALE_BLUE_DARK,
    info: theme.text.feedback.info.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    good: theme.text.feedback.success.base,
    warn: theme.text.feedback.warning.base,
    bad: theme.text.feedback.error.base,
    text: theme.text.base,
    leader: theme.hue.accent[300] ?? theme.text.feedback.info.base,
    border: theme.border.base,
    panel,
    focus: theme.text.base,
    // Ticket #173: the focused Work card uses the highest-contrast tone against
    // the host surface. The host's `text.action.primary.focused` is the fill of
    // a filled action chip (dark in the default theme), so it cannot be the
    // border tone. The pane's own focus border stays `focus`.
    cardFocus: contrastText(panel),
    categorical: (theme as any).categorical ?? [],
    bg: theme.background?.base ?? theme.text.base,
  }
}

export type ThemeColor = RGBA | string

/**
 * Ticket #173: the one card-border mapping. A focused Work card is white; an
 * unfocused card keeps the subdued grey border. Pane focus is a separate
 * state drawn on the pane border, never on the cards.
 */
export function workCardBorderColor(
  colors: Pick<Palette, "cardFocus" | "border">,
  focused: boolean,
): ThemeColor {
  return focused ? colors.cardFocus : colors.border
}

function toRgba(color: ThemeColor | null | undefined): RGBA | null {
  if (!color) return null
  if (color instanceof RGBA) return color
  if (typeof color !== "string") return null
  if (["transparent", "default", "none"].includes(color.trim().toLowerCase())) return null
  try {
    return RGBA.fromHex(color)
  } catch {
    return null
  }
}

function rgbaLuminance(rgba: RGBA): number {
  const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(rgba.r) + 0.7152 * linear(rgba.g) + 0.0722 * linear(rgba.b)
}

function relativeLuminance(color: ThemeColor): number | null {
  const rgba = toRgba(color)
  return rgba ? rgbaLuminance(rgba) : null
}

/**
 * Ticket #259: WCAG contrast ratio between two colors. Returns null when
 * either side is not a concrete color (for example `transparent`), so a
 * caller cannot accidentally treat "unknown" as a passing value.
 */
export function contrastRatio(foreground: ThemeColor, background: ThemeColor): number | null {
  const foregroundRgba = toRgba(foreground)
  const backgroundRgba = toRgba(background)
  // A translucent color has no single contrast ratio: its rendered value
  // depends on the backdrop behind it.
  if (!foregroundRgba || !backgroundRgba || foregroundRgba.a < 1 || backgroundRgba.a < 1) return null
  const foregroundLuminance = rgbaLuminance(foregroundRgba)
  const backgroundLuminance = rgbaLuminance(backgroundRgba)
  const lighter = Math.max(foregroundLuminance, backgroundLuminance)
  const darker = Math.min(foregroundLuminance, backgroundLuminance)
  return (lighter + 0.05) / (darker + 0.05)
}

/** True when a foreground/background pair meets the WCAG AA threshold for its role. */
export function meetsContrast(foreground: ThemeColor, background: ThemeColor, role: "text" | "ui"): boolean {
  const ratio = contrastRatio(foreground, background)
  return ratio !== null && ratio >= (role === "text" ? WCAG_AA_TEXT : WCAG_AA_UI)
}

/** Automatic black/white text for a filled chip or badge. */
export function contrastText(color: ThemeColor): "#000000" | "#ffffff" {
  const luminance = relativeLuminance(color)
  if (luminance === null) return "#ffffff"
  // WCAG crossover: black wins above L=0.179, white below it.
  return luminance > 0.179 ? "#000000" : "#ffffff"
}
