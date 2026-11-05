import { RGBA } from "@opentui/core"

export type Palette = {
  accent: RGBA | string
  muted: RGBA | string
  faint: RGBA | string
  good: RGBA | string
  warn: RGBA | string
  bad: RGBA | string
  text: RGBA | string
  leader: RGBA | string
  border: RGBA | string
  panel: RGBA | string
  focus: RGBA | string
  categorical: readonly any[]
  bg: RGBA | string
}

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
}): Palette {
  const background = (theme as any).background?.raised?.base ?? (theme as any).background?.base
  const panel = background && typeof background === "object" && background.a >= 1 ? background : "#101010"
  return {
    accent: (theme as any).hue?.accent?.[200] ?? theme.text.feedback.info.base,
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
    categorical: (theme as any).categorical ?? [],
    bg: theme.background?.base ?? theme.text.base,
  }
}

export type ThemeColor = RGBA | string

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

/** True only for a resolved, fully opaque color (not the terminal default). */
export function isOpaqueColor(color: ThemeColor | null | undefined): boolean {
  const rgba = toRgba(color)
  if (!rgba) return false
  if (rgba.intent === "default") return false
  return rgba.a >= 1
}

function colorToHex(color: ThemeColor): string | null {
  const rgba = toRgba(color)
  if (!rgba) return null
  const [r, g, b] = rgba.toInts()
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

function relativeLuminance(color: ThemeColor): number | null {
  const rgba = toRgba(color)
  if (!rgba) return null
  const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(rgba.r) + 0.7152 * linear(rgba.g) + 0.0722 * linear(rgba.b)
}

/** Automatic black/white text for a filled chip or badge. */
export function contrastText(color: ThemeColor): "#000000" | "#ffffff" {
  const luminance = relativeLuminance(color)
  if (luminance === null) return "#ffffff"
  // WCAG crossover: black wins above L=0.179, white below it.
  return luminance > 0.179 ? "#000000" : "#ffffff"
}

/** Last-resort opaque surface when neither the terminal nor the theme reports one. */
export const OPAQUE_FALLBACK = "#101010"

/**
 * Opaque surface painted behind the rail and the leader badge. The terminal
 * default background wins when the palette detection reported a real color;
 * otherwise the opaque panel color is used, then a constant. Always returns a
 * hex color so the badge text can be a true cutout.
 */
export function opaqueSurface(
  candidate: ThemeColor | null | undefined,
  fallback: ThemeColor | null | undefined,
): string {
  const chosen = isOpaqueColor(candidate) ? candidate! : isOpaqueColor(fallback) ? fallback! : OPAQUE_FALLBACK
  return colorToHex(chosen) ?? OPAQUE_FALLBACK
}

export type LeaderBadge = { background: ThemeColor; foreground: string }

/**
 * Leader badge colors. A guaranteed opaque surface makes the text a true
 * cutout (the glyphs paint the same color as the rail). Without a guarantee,
 * the text falls back to automatic black/white contrast from the accent.
 */
export function leaderBadge(accent: ThemeColor, surface: ThemeColor | null | undefined): LeaderBadge {
  const cutout = isOpaqueColor(surface) ? colorToHex(surface!) : null
  return { background: accent, foreground: cutout ?? contrastText(accent) }
}
