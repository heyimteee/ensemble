/**
 * Ticket #259: the single ASCII fallback vocabulary for the TUI.
 *
 * Motion frames, Work status marks, the resolved-approval mark, and the init
 * stage marks all read from this map. Keeping one collection means a terminal
 * without Unicode or a Braille font cannot grow a second glyph convention in a
 * different renderer. The state word always carries the meaning; these marks
 * only keep the glyph slot legible.
 */
export const ASCII_GLYPHS = {
  working: "*",
  waiting: "-",
  workWaiting: "o",
  tool: ">",
  thinking: ".  ",
  queued: "-",
  emptyState: "o---o---o",
  pending: "-",
  retrying: "~",
  needsYou: "!",
  replied: "+",
  failed: "x",
  stalled: "%",
  cancelled: "/",
  resolved: "+",
  stageFilled: "#",
  stageEmpty: "-",
} as const
