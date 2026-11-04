/**
 * Two-row statusline strings (ticket #79).
 *
 * Pure text builders for the always-reserved bottom bar. Row one carries the
 * mode chip, context, git state, focused position, pending chord, and context
 * hints. Row two carries command input when active, otherwise the latest
 * transient message, otherwise a single blank cell so the layout never jumps.
 */

import type { GitState } from "./git.ts"
import type { CommandInput, InteractionFocus, InteractionMode, InteractionOverlay } from "./interaction.ts"

export type StatuslineSurface = "none" | "agent" | "workspace"

export function modeLabel(mode: InteractionMode): string {
  if (mode === "insert") return "INSERT"
  if (mode === "command") return "COMMAND"
  return "NORMAL"
}

/** Overlay precedence first, then the composer, then the focused surface. */
export function contextLabel(input: {
  focus: InteractionFocus
  overlay: InteractionOverlay
  surface: StatuslineSurface
}): string {
  switch (input.overlay) {
    case "settings":
      return "Settings"
    case "wizard":
      return "Wizard"
    case "dialog":
      return "Dialog"
    case "approvals":
      return "Approvals"
    case "help":
      return "Help"
    case "none":
      break
  }
  switch (input.focus) {
    case "settings":
      return "Settings"
    case "wizard":
      return "Wizard"
    case "dialog":
      return "Dialog"
    case "approvals":
      return "Approvals"
    case "help":
      return "Help"
    case "rail":
    case "chat":
    case "composer":
      break
  }
  if (input.focus === "composer") {
    if (input.surface === "agent") return "COMPOSER · Direct conversation"
    if (input.surface === "workspace") return "COMPOSER · Group chat"
    return "COMPOSER"
  }
  if (input.focus === "rail") return "Roster"
  if (input.surface === "agent") return "Direct conversation"
  if (input.surface === "workspace") return "Group chat"
  return "Roster"
}

export function gitLabel(git: GitState | null): string {
  if (!git) return "git:(-)"
  let label = `git:(${git.branch}${git.dirty ? "*" : ""})`
  if (git.ahead > 0) label += ` ↑${git.ahead}`
  if (git.behind > 0) label += ` ↓${git.behind}`
  return label
}

/** Composer position in Vim's `line:column` form (1-based, cursor cell inclusive). */
export function composerPosition(text: string, offset: number): string {
  const clamped = Math.max(0, Math.min(text.length, Math.trunc(offset)))
  const before = text.slice(0, clamped)
  const line = before.split("\n").length
  const lastBreak = before.lastIndexOf("\n")
  const column = clamped - lastBreak
  return `${line}:${column}`
}

/** List position as `row/total`; an empty list still renders a stable `0/0`. */
export function listPosition(cursor: number, total: number): string {
  if (total <= 0) return "0/0"
  return `${Math.max(1, Math.min(total, Math.trunc(cursor) + 1))}/${total}`
}

export function statuslineRow1(input: {
  mode: InteractionMode
  context: string
  git?: GitState | null
  position?: string
  pendingChord?: string | null
  hints?: string
}): string {
  const parts = [modeLabel(input.mode), input.context]
  if (input.git !== undefined) parts.push(gitLabel(input.git))
  if (input.position) parts.push(input.position)
  if (input.pendingChord) parts.push(`chord ${input.pendingChord}`)
  if (input.hints) parts.push(input.hints)
  return parts.join(" · ")
}

export function statuslineRow2(input: {
  command?: CommandInput | null
  message?: string | null
}): string {
  if (input.command) return `${input.command.kind}${input.command.text}`
  if (input.message) return input.message
  return " "
}
