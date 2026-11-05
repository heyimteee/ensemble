/**
 * Slice E chrome seam (ticket #65, brief §2.0/2.1/2.7–2.10).
 *
 * Pure helpers behind the final chrome polish: the single-focus model, the
 * context-sensitive footer, and the empty-state copy. Overlay footer keys now
 * come from the shared keymap catalog (v5.6 T6). No rendering, no signals —
 * callers wire these into the Solid tree so exactly one focus-colored border
 * renders at all times and every hint matches the actions actually available.
 */

import { statuslineHints } from "./keymap.ts"
import { chromeJoin, chromeSeparator } from "./separators.ts"

/** Columns that can own the chat-surface focus. The composer is a distinct focus state (brief §2.10). */
export type ChromeFocusArea = "rail" | "chat"

/** The single owner of the focus-colored border. Overlays sit above the columns. */
export type ChromeFocus = "rail" | "chat" | "composer" | "overlay"

/**
 * Resolve the one focus owner. Precedence is overlay, then composer, then
 * the column: a dialog owns Enter/Escape while open, and the composer owns
 * them while composing (the global work/rail layer is disabled in both).
 * Exactly one area owns the focus border in every state.
 */
export function resolveChromeFocus(input: {
  focusArea: ChromeFocusArea
  composerActive: boolean
  overlayOpen: boolean
}): ChromeFocus {
  if (input.overlayOpen) return "overlay"
  if (input.composerActive) return "composer"
  return input.focusArea
}

/** True exactly when `area` owns the single focus-colored border. */
export function chromeOwnsFocus(focus: ChromeFocus, area: ChromeFocus): boolean {
  return focus === area
}

export type FooterContext = {
  focus: ChromeFocus
  hasWork: boolean
  missingSkills: string[]
}

/** Global footer line 1: context-aware navigation hints, never naming hidden work. */
export function footerLine1(context: { focus: ChromeFocus; hasWork: boolean }): string {
  switch (context.focus) {
    case "composer":
      return statuslineHints("composerInsert", {
        filter: (entry) => entry.id !== "composerInsert.stop",
      })
    case "overlay":
      return chromeJoin(["esc cancel", "dialog open — close to return"])
    case "rail":
      return statuslineHints("roster")
    case "chat":
      return statuslineHints("chat", { hasWork: context.hasWork })
  }
}

/**
 * Global footer line 2: work keys render only while the WORK block mounts
 * (and never while the composer or a dialog owns the keyboard, where the
 * global work bindings are disabled). The missing-skills warning keeps
 * precedence over every work hint.
 */
export function footerLine2(context: FooterContext): string {
  if (context.missingSkills.length > 0) return `! missing skills: ${context.missingSkills.join(", ")}`
  const workLive = context.hasWork && context.focus !== "composer" && context.focus !== "overlay"
  if (workLive) return chromeJoin(["tab work", "space leader", "/ search", "p pause", "s settings"])
  return chromeJoin(["space leader", "/ search", "p pause", "s settings"])
}

/** Rail empty state: names both fixes with their keys (brief §2.1). */
export function railEmptyLine(): string {
  return chromeJoin(["No agents or workspaces yet. n new workspace", "a new agent"])
}

/** Skill palette zero state: names the miss and the fix (filter without a dialog). */
export function skillsEmptyLine(): string {
  return "No matching skills — refine filter."
}

/** Shortcut help zero state: names the miss and the fix. */
export function helpEmptyLine(): string {
  return "No matching shortcuts — refine filter."
}

/** Picker/wizard filter zero state: names the miss and the fix. */
export function pickerEmptyLine(): string {
  return "No matches — refine filter"
}

/** Approvals inbox zero state: names that no action is needed (brief §2.8 — correct as-is). */
export function approvalsEmptyLine(): string {
  return "Nothing waits for you."
}

/** Direct-chat empty detail: the existing line plus its compose key (brief §2.2 names the key). */
export function dmEmptyDetail(): string {
  return "Send a direct message. It goes to this agent's native OpenCode session. i to compose."
}

/** Approval row suffix: `Resolving…` while that approval's resolve RPC is in flight, else empty. */
export function approvalResolvingSuffix(resolving: boolean): string {
  return resolving ? ` ${chromeSeparator()} Resolving…` : ""
}

/** Inbox origin tag: native host blocks read differently from product decisions. Pure. */
export function approvalSourceTag(source: string): string {
  switch (source) {
    case "native":
      return "Native"
    case "agent":
      return "Agent"
    case "workspace":
      return "Workspace"
    case "memory":
      return "Memory"
    default:
      return "Workspace"
  }
}
