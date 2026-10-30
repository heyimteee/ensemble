import type { RGBA } from "@opentui/core"

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
    bg: theme.background?.base ?? theme.text.base,
  }
}
