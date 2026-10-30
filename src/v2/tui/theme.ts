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
  background?: { base: RGBA }
  hue: { accent: Record<number, RGBA> }
}): Palette {
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
    focus: theme.text.action.primary.focused,
    categorical: (theme as any).categorical ?? [],
    bg: theme.background?.base ?? theme.text.base,
  }
}
