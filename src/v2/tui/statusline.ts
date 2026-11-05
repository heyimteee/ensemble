/**
 * Two-row statusline (ticket #79; typed segments in v5.7 T3, ticket #93).
 *
 * Row one is built from typed segments: a filled mode chip, context, git,
 * position/selection, pending chord, and hints. Each part carries a palette
 * tone so the renderer can paint hint keys, descriptions, git, and position
 * differently. Row two is the command input or the latest message with a
 * success/error tone. Plain-text formatters stay available for tests and the
 * live harness.
 *
 * Fitting keeps the mode chip in every width and drops hint segments from
 * the right before any core segment. Row two is dedicated to the command
 * input, so no hint can truncate it.
 */

import type { GitState } from "./git.ts"
import type {
  CommandInput,
  InteractionFocus,
  InteractionMode,
  InteractionOverlay,
  InteractionSelection,
} from "./interaction.ts"
import { CHROME_SEPARATOR, chromeJoin, chromeSeparator, chromeSplit } from "./separators.ts"

export type StatuslineSurface = "none" | "agent" | "workspace"

export function modeLabel(mode: InteractionMode, visualKind?: InteractionSelection["kind"]): string {
  if (mode === "insert") return "INSERT"
  if (mode === "command") return "COMMAND"
  if (mode === "visual") return visualKind === "line" ? "V-LINE" : "VISUAL"
  return "NORMAL"
}

const OVERLAY_LABELS: Record<Exclude<InteractionOverlay, "none">, string> = {
  settings: "Settings",
  wizard: "Wizard",
  dialog: "Dialog",
  approvals: "Approvals",
  help: "Help",
}

const FOCUS_LABELS: Partial<Record<InteractionFocus, string>> = {
  settings: "Settings",
  wizard: "Wizard",
  dialog: "Dialog",
  approvals: "Approvals",
  help: "Help",
  work: "Work list",
}

/** Overlay precedence first, then the composer, then the focused surface. */
export function contextLabel(input: {
  focus: InteractionFocus
  overlay: InteractionOverlay
  surface: StatuslineSurface
}): string {
  if (input.overlay !== "none") return OVERLAY_LABELS[input.overlay]
  const focused = FOCUS_LABELS[input.focus]
  if (focused) return focused
  if (input.focus === "composer") {
    if (input.surface === "agent") return chromeJoin(["COMPOSER", "Direct conversation"])
    if (input.surface === "workspace") return chromeJoin(["COMPOSER", "Group chat"])
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

/**
 * Transcript scroll position as a real percentage of the scrollable range.
 * A transcript shorter than its viewport is fully visible, so it reads 100%;
 * top is 0% and bottom is 100%.
 */
export function transcriptPosition(scrollTop: number, scrollHeight: number, viewportHeight: number): string {
  const max = Math.max(0, Number(scrollHeight) - Number(viewportHeight))
  if (max <= 0) return "100%"
  const top = Math.max(0, Math.min(max, Number(scrollTop)))
  return `${Math.round((top / max) * 100)}%`
}

/** List position as `row/total`; an empty list still renders a stable `0/0`. */
export function listPosition(cursor: number, total: number): string {
  if (total <= 0) return "0/0"
  return `${Math.max(1, Math.min(total, Math.trunc(cursor) + 1))}/${total}`
}

export type StatuslineTone = "text" | "muted" | "faint" | "accent" | "good" | "warn" | "bad" | "leader" | "chip"
export type StatuslineChipRole = "muted" | "accent" | "good" | "warn" | "leader"
export type StatuslinePart = {
  text: string
  tone: StatuslineTone
  /** A filled chip background role; the renderer pairs it with contrast text. */
  chip?: StatuslineChipRole
}
export type StatuslineSegmentKind = "mode" | "context" | "selection" | "git" | "position" | "chord" | "hint"
export type StatuslineSegment = { kind: StatuslineSegmentKind; parts: StatuslinePart[] }

/** Theme chip role for the current mode. */
export function modeChipRole(mode: InteractionMode, leader = false): StatuslineChipRole {
  if (leader) return "leader"
  if (mode === "insert") return "good"
  if (mode === "visual") return "warn"
  if (mode === "command") return "accent"
  return "muted"
}

export function modeSegment(mode: InteractionMode, visualKind?: InteractionSelection["kind"], leader = false): StatuslineSegment {
  return {
    kind: "mode",
    parts: [{ text: modeLabel(mode, visualKind), tone: "chip", chip: modeChipRole(mode, leader) }],
  }
}

export function contextSegment(context: string): StatuslineSegment {
  return { kind: "context", parts: [{ text: context, tone: "muted" }] }
}

export function gitSegments(git: GitState | null): StatuslineSegment {
  if (!git) return { kind: "git", parts: [{ text: gitLabel(null), tone: "muted" }] }
  const parts: StatuslinePart[] = [
    { text: "git:(", tone: "accent" },
    { text: git.branch, tone: "accent" },
  ]
  if (git.dirty) parts.push({ text: "*", tone: "warn" })
  parts.push({ text: ")", tone: "accent" })
  if (git.ahead > 0) parts.push({ text: ` ↑${git.ahead}`, tone: "good" })
  if (git.behind > 0) parts.push({ text: ` ↓${git.behind}`, tone: "warn" })
  return { kind: "git", parts }
}

export function selectionSegment(size: string): StatuslineSegment {
  return { kind: "selection", parts: [{ text: size, tone: "warn" }] }
}

export function positionSegment(position: string): StatuslineSegment {
  return { kind: "position", parts: [{ text: position, tone: "accent" }] }
}

export function chordSegment(chord: string): StatuslineSegment {
  return { kind: "chord", parts: [{ text: `chord ${chord}`, tone: "warn" }] }
}

/**
 * Split a catalog hint list into accent key + muted description segments.
 * Hints are the only droppable segments when the bar is narrow.
 */
export function hintSegments(hints: string | null | undefined, separator: string = chromeSeparator()): StatuslineSegment[] {
  if (!hints) return []
  return chromeSplit(hints, separator)
    .map((hint) => hint.trim())
    .filter((hint) => hint.length > 0)
    .map((hint) => {
      const space = hint.indexOf(" ")
      const key = space === -1 ? hint : hint.slice(0, space)
      const description = space === -1 ? "" : hint.slice(space + 1)
      const parts: StatuslinePart[] = [{ text: key, tone: "accent" }]
      if (description) parts.push({ text: ` ${description}`, tone: "muted" })
      return { kind: "hint", parts } satisfies StatuslineSegment
    })
}

export type StatuslineRow1Input = {
  mode: InteractionMode
  visualKind?: InteractionSelection["kind"]
  /** The leader menu is open; the chip uses the leader accent. */
  leader?: boolean
  context: string
  git?: GitState | null
  position?: string
  /** Visual selection size, e.g. `3 chars` or `2 lines`. */
  selectionSize?: string
  pendingChord?: string | null
  hints?: string
}

export function buildStatuslineSegments(input: StatuslineRow1Input, separator: string = chromeSeparator()): StatuslineSegment[] {
  const segments: StatuslineSegment[] = [modeSegment(input.mode, input.visualKind, input.leader), contextSegment(input.context)]
  if (input.selectionSize) segments.push(selectionSegment(input.selectionSize))
  if (input.git !== undefined) segments.push(gitSegments(input.git))
  if (input.position) segments.push(positionSegment(input.position))
  if (input.pendingChord) segments.push(chordSegment(input.pendingChord))
  segments.push(...hintSegments(input.hints, separator))
  return segments
}

export function segmentText(segment: StatuslineSegment): string {
  return segment.parts.map((part) => part.text).join("")
}

export function formatStatuslineSegments(segments: readonly StatuslineSegment[], separator: string = chromeSeparator()): string {
  return chromeJoin(segments.map(segmentText), separator)
}

export function statuslineRow1(input: StatuslineRow1Input, separator: string = chromeSeparator()): string {
  return formatStatuslineSegments(buildStatuslineSegments(input, separator), separator)
}

/**
 * Fit row one to the terminal width. Hints disappear from the right first;
 * only after every hint is gone do optional core segments drop. The mode chip
 * is never dropped, so the current interaction state always stays visible.
 */
export function fitStatuslineSegments(
  segments: readonly StatuslineSegment[],
  maxWidth: number,
  separator: string = chromeSeparator(),
): StatuslineSegment[] {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return [...segments]
  const kept = [...segments]
  while (kept.length > 1 && statuslineWidth(kept, separator) > maxWidth) {
    const hintIndex = lastIndexWhere(kept, (segment) => segment.kind === "hint")
    if (hintIndex >= 0) {
      kept.splice(hintIndex, 1)
      continue
    }
    const modeIndex = kept.findIndex((segment) => segment.kind === "mode")
    const dropIndex = kept.length - 1
    if (dropIndex === modeIndex) break
    kept.splice(dropIndex, 1)
  }
  return kept
}

function statuslineWidth(segments: readonly StatuslineSegment[], separator: string): number {
  if (segments.length === 0) return 0
  const content = segments.reduce((total, segment) => total + displayWidth(segmentText(segment)), 0)
  return content + displayWidth(` ${separator} `) * (segments.length - 1)
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index
  }
  return -1
}

/** Terminal cell width for the printable strings the statusline builds. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0x200d || (code >= 0x0300 && code <= 0x036f)) continue
    width += isWideCodePoint(code) ? 2 : 1
  }
  return width
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export type StatuslineMessageTone = "info" | "success" | "error"

export function statuslineRow2Parts(input: {
  command?: CommandInput | null
  message?: string | null
  tone?: StatuslineMessageTone
}): StatuslinePart[] {
  if (input.command) {
    return [
      { text: input.command.kind, tone: "accent" },
      { text: input.command.text, tone: "text" },
    ]
  }
  if (input.message) {
    const tone: StatuslineTone = input.tone === "error" ? "bad" : input.tone === "success" ? "good" : "faint"
    return [{ text: input.message, tone }]
  }
  return [{ text: " ", tone: "faint" }]
}

export function statuslineRow2(input: {
  command?: CommandInput | null
  message?: string | null
  tone?: StatuslineMessageTone
}): string {
  return statuslineRow2Parts(input)
    .map((part) => part.text)
    .join("")
}

/** Exposed for tests that pin the shared chrome glyph. */
export const STATUSLINE_SEPARATOR = CHROME_SEPARATOR
