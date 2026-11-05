/**
 * v5.6 T10: the complete, sectioned help catalog (ticket #88).
 *
 * Help is not hand-written. Every key, chord, leader action, command, and
 * mouse gesture comes from the same tables that drive the keymap layers, the
 * which-key popup, and the statusline. The completeness checker compares the
 * generated sections against those tables so an omission or duplicate fails
 * a test instead of drifting into the overlay.
 */

import { COMMANDS, type CommandSpec } from "./commands.ts"
import { fuzzyMatch } from "./format.ts"
import { KEYMAP_CATALOG, keyChordLabel, type KeyContext, type KeyEntry } from "./keymap.ts"
import { MOUSE_GESTURES, type MouseGestureSpec } from "./mouse.ts"

export type HelpSectionID =
  | "modes"
  | "global"
  | "roster"
  | "conversation"
  | "work"
  | "composer-insert"
  | "composer-normal"
  | "composer-visual"
  | "settings"
  | "wizard"
  | "dialogs"
  | "command"
  | "leader"
  | "clipboard-mouse"
  | "statusline"
  | "native"

export type HelpSectionSpec = { id: HelpSectionID; title: string }

export const HELP_SECTION_ORDER: readonly HelpSectionSpec[] = [
  { id: "modes", title: "Modes and Esc ladder" },
  { id: "global", title: "Global keys" },
  { id: "roster", title: "Roster" },
  { id: "conversation", title: "Group chat and Direct conversation" },
  { id: "work", title: "Work list" },
  { id: "composer-insert", title: "Composer · Insert" },
  { id: "composer-normal", title: "Composer · Normal" },
  { id: "composer-visual", title: "Composer · Visual" },
  { id: "settings", title: "Settings" },
  { id: "wizard", title: "Wizard" },
  { id: "dialogs", title: "Dialogs" },
  { id: "command", title: "Command and search" },
  { id: "leader", title: "Leader menu" },
  { id: "clipboard-mouse", title: "Clipboard and mouse" },
  { id: "statusline", title: "Statusline legend" },
  { id: "native", title: "Native-session scope" },
]

export type HelpSource =
  | { kind: "keymap"; id: string; context: KeyContext | "leader" }
  | { kind: "command"; id: string }
  | { kind: "mouse"; id: string }
  | { kind: "info"; id: string }

export type HelpEntry = {
  /** Stable per-section identity; also the renderable id suffix. */
  id: string
  /** Display column, already platform-labelled. Empty for prose-only rows. */
  keys: string
  title: string
  source: HelpSource
}

export type HelpSection = {
  id: HelpSectionID
  title: string
  entries: HelpEntry[]
}

export type HelpCatalogInput = {
  keymap?: readonly KeyEntry[]
  commands?: readonly CommandSpec[]
  mouse?: readonly MouseGestureSpec[]
  /** Override the generated sections, used by the completeness checker tests. */
  sections?: readonly HelpSection[]
}

const CONTEXT_SECTIONS: Record<KeyContext, HelpSectionID> = {
  global: "global",
  roster: "roster",
  chat: "conversation",
  work: "work",
  composer: "composer-insert",
  settings: "settings",
  settingsField: "settings",
  settingsText: "settings",
  wizard: "wizard",
  wizardField: "wizard",
  wizardText: "wizard",
  picker: "dialogs",
  promptField: "dialogs",
  promptText: "dialogs",
  confirm: "dialogs",
  result: "dialogs",
  approvals: "dialogs",
  filter: "dialogs",
  help: "global",
  command: "command",
  search: "command",
  completion: "composer-insert",
  composerInsert: "composer-insert",
  composerNormal: "composer-normal",
  composerVisual: "composer-visual",
}

export function helpSectionForContext(context: KeyContext): HelpSectionID {
  return CONTEXT_SECTIONS[context]
}

function info(section: HelpSectionID, id: string, keys: string, title: string): HelpEntry {
  return { id, keys, title, source: { kind: "info", id: `info.${id}` } }
}

/** Prose rows that explain policy rather than duplicate a key binding. */
const INFO_ENTRIES: Readonly<Record<HelpSectionID, readonly HelpEntry[]>> = {
  modes: [
    info("modes", "mode.normal", "NORMAL", "Lists navigate rows; text buffers run the Vim subset."),
    info("modes", "mode.insert", "INSERT", "Type into the focused composer or text field."),
    info("modes", "mode.visual", "VISUAL / V-LINE", "Select text by character or line, then yank, cut, or change."),
    info("modes", "mode.command", "COMMAND", "The : command line or the / search/filter input."),
    info("modes", "escape.insert", "Esc", "Insert → Normal (composer or text field)."),
    info("modes", "escape.visual", "Esc", "Visual → Normal."),
    info("modes", "escape.composer", "Esc", "Composer Normal → chat Normal."),
    info("modes", "escape.settings.field", "Esc", "Settings text field Normal → settings Normal."),
    info("modes", "escape.settings", "Esc", "Settings Normal → close settings."),
    info("modes", "escape.wizard.field", "Esc", "Wizard text field Normal → step Normal."),
    info("modes", "escape.wizard", "Esc", "Wizard step Normal → previous step, or cancel at the first step."),
    info("modes", "escape.dialog", "Esc", "Cancel the dialog, picker, confirm, result, or approval inbox."),
    info("modes", "escape.command", "Esc", "Command → Normal, restoring the previous filter."),
    info("modes", "escape.chat", "Esc", "Clear a filter or committed search; otherwise a no-op."),
    info("modes", "escape.never", "Esc", "Esc never leaves Ensemble. Quit deliberately with :q or Space q."),
    info("modes", "escape.ctrl-g", "Ctrl+G", "Leave the focused composer, settings, wizard, or prompt text field immediately when the host consumes Esc."),
  ],
  global: [
    info("global", "focus.zones", "Tab / Shift+Tab", "Move focus zones between the roster, transcript, and work list. Enter the composer with i or Enter, not Tab."),
    info("global", "esc", "Esc", "Go up one level. The full ladder is in Modes and Esc ladder."),
    info("global", "quit", ":q / Space q", "Leave Ensemble deliberately; no other key quits."),
  ],
  roster: [
    info("roster", "destructive", "x / X", "x archives; X deletes and asks for confirmation."),
  ],
  conversation: [
    info("conversation", "no-cursor", "j / k", "Scroll the transcript by line; there is no message cursor."),
  ],
  work: [
    info("work", "context", "d", "Delegates in the work list; inside a text buffer d is the delete operator."),
  ],
  "composer-insert": [
    info("composer-insert", "typing", "text", "Type at the cursor. Enter sends and keeps Insert focus; Shift+Enter adds a line."),
  ],
  "composer-normal": [
    info("composer-normal", "subset", "Vim subset", "No counts, text objects, macros, marks, or extra registers."),
  ],
  "composer-visual": [
    info("composer-visual", "extend", "motions", "Motions extend the selection; o swaps its ends."),
  ],
  settings: [
    info("settings", "text", "Insert / Normal / Visual", "Text fields use the composer grammar; Esc returns to the settings rows, and Ctrl+G leaves the field directly."),
  ],
  wizard: [
    info("wizard", "text", "Insert / Normal / Visual", "Text fields use the composer grammar; Esc returns to the step, and Ctrl+G leaves the field immediately."),
  ],
  dialogs: [
    info("dialogs", "shared", "", "Pickers, prompts, confirms, results, and approvals share one grammar: j/k, Enter, Space, /, Esc."),
  ],
  command: [
    info("command", "scope", ":", "Commands navigate or change state only; destructive actions stay on keys and the leader with their confirms."),
  ],
  leader: [
    info("leader", "space", "Space", "Leader key opens the which-key menu; Esc cancels it."),
  ],
  "clipboard-mouse": [
    info("clipboard-mouse", "yank", "y / yy", "Yank to the system clipboard."),
    info("clipboard-mouse", "cut", "d / dd / x", "Deletes are cuts and also write to the system clipboard."),
    info("clipboard-mouse", "paste", "p / P", "Read the system clipboard first; the internal register is the fallback."),
    info("clipboard-mouse", "visual", "Visual y / d / c", "Yank, cut, or change the selected range."),
    info("clipboard-mouse", "async", "async", "A paste is discarded if focus or the buffer changed while the clipboard read was in flight."),
    info("clipboard-mouse", "toast", "toast", "Copy success clears a mouse selection; failure keeps it and shows an error."),
  ],
  statusline: [
    info("statusline", "mode", "mode", "Chip: NORMAL, INSERT, VISUAL, V-LINE, or COMMAND."),
    info("statusline", "context", "context", "Roster, Group chat, Direct conversation, Work list, Settings, Wizard, Dialog, Approvals, or Help."),
    info("statusline", "git", "git:(branch*)", "Branch, dirty mark, ahead ↑, and behind ↓ counts."),
    info("statusline", "position", "position", "line:col in a text buffer, row/total in a list, or percent in the transcript."),
    info("statusline", "chord", "chord", "Pending multi-key prefix, e.g. g."),
    info("statusline", "hints", "hints", "Context keys generated from the binding catalog, e.g. enter open · / filter · space leader."),
    info("statusline", "row2", "row 2", ": or / input while active; otherwise the latest transient message; otherwise blank."),
  ],
  native: [
    info("native", "scope", "", "Native-session keys are owned by the host; F2 returns to Ensemble."),
  ],
}

function keymapLabel(entry: KeyEntry): string {
  return keyChordLabel(entry.keys)
}

function keymapHelpEntry(entry: KeyEntry, context: KeyContext | "leader"): HelpEntry {
  const base = keymapLabel(entry)
  const keys = context === "leader"
    ? entry.id === "leader.cancel"
      ? base
      : `Space ${base}`
    : base
  return {
    id: `keymap.${context}.${entry.id}`,
    keys,
    title: entry.title,
    source: { kind: "keymap", id: entry.id, context },
  }
}

function commandHelpEntry(command: CommandSpec): HelpEntry {
  return {
    id: `command.${command.name}`,
    keys: `:${command.name}`,
    title: command.description,
    source: { kind: "command", id: command.name },
  }
}

function mouseHelpEntry(gesture: MouseGestureSpec): HelpEntry {
  return {
    id: `mouse.${gesture.id}`,
    keys: gesture.gesture,
    title: gesture.title,
    source: { kind: "mouse", id: gesture.id },
  }
}

export function helpSections(input: HelpCatalogInput = {}): HelpSection[] {
  const keymap = input.keymap ?? KEYMAP_CATALOG
  const commands = input.commands ?? COMMANDS
  const mouse = input.mouse ?? MOUSE_GESTURES
  const sections = new Map<HelpSectionID, HelpSection>(
    HELP_SECTION_ORDER.map((section) => [section.id, { ...section, entries: [] }]),
  )
  const add = (sectionID: HelpSectionID, entry: HelpEntry) => {
    sections.get(sectionID)?.entries.push(entry)
  }

  for (const entry of keymap) {
    if (entry.scope === "leader") {
      add("leader", keymapHelpEntry(entry, "leader"))
      continue
    }
    for (const context of entry.contexts) {
      add(helpSectionForContext(context), keymapHelpEntry(entry, context))
    }
  }
  for (const command of commands) add("command", commandHelpEntry(command))
  for (const gesture of mouse) add("clipboard-mouse", mouseHelpEntry(gesture))
  for (const section of HELP_SECTION_ORDER) {
    for (const entry of INFO_ENTRIES[section.id]) add(section.id, entry)
  }
  return HELP_SECTION_ORDER.map((section) => sections.get(section.id)!)
}

export function helpEntryKey(section: Pick<HelpSection, "id">, entry: Pick<HelpEntry, "id">): string {
  return `${section.id}:${entry.id}`
}

/** Fuzzy filter by section title, key label, action, or policy text. */
export function filterHelpSections(sections: readonly HelpSection[], query: string): HelpSection[] {
  const needle = query.trim()
  if (!needle) return sections.map((section) => ({ ...section, entries: [...section.entries] }))
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) =>
        fuzzyMatch(needle, `${section.title} ${entry.keys} ${entry.title}`),
      ),
    }))
    .filter((section) => section.entries.length > 0)
}

/** Next/previous match with wraparound; an empty result stays at zero. */
export function helpMatchAfter(total: number, current: number, direction: 1 | -1): number {
  if (total <= 0) return 0
  const base = Math.max(0, Math.min(total - 1, Math.trunc(current)))
  return (base + direction + total) % total
}

export type HelpCoverageIssues = {
  missing: string[]
  duplicates: string[]
  unexpected: string[]
  misplaced: string[]
}

function sourceKey(source: HelpSource): string | null {
  if (source.kind === "keymap") return `keymap:${source.context}:${source.id}`
  if (source.kind === "command") return `command:${source.id}`
  if (source.kind === "mouse") return `mouse:${source.id}`
  return null
}

function expectedSources(input: HelpCatalogInput): Map<string, HelpSectionID> {
  const expected = new Map<string, HelpSectionID>()
  for (const entry of input.keymap ?? KEYMAP_CATALOG) {
    if (entry.scope === "leader") {
      expected.set(`keymap:leader:${entry.id}`, "leader")
      continue
    }
    for (const context of entry.contexts) {
      expected.set(`keymap:${context}:${entry.id}`, helpSectionForContext(context))
    }
  }
  for (const command of input.commands ?? COMMANDS) {
    expected.set(`command:${command.name}`, "command")
  }
  for (const gesture of input.mouse ?? MOUSE_GESTURES) {
    expected.set(`mouse:${gesture.id}`, "clipboard-mouse")
  }
  return expected
}

/**
 * Prove the generated help equals the binding/command/gesture catalogs:
 * each source appears exactly once, in the section its context names.
 */
export function helpCoverageIssues(input: HelpCatalogInput = {}): HelpCoverageIssues {
  const sections = input.sections ?? helpSections(input)
  const expected = expectedSources(input)
  const counts = new Map<string, number>()
  const actual = new Map<string, HelpSectionID>()
  for (const section of sections) {
    for (const entry of section.entries) {
      const key = sourceKey(entry.source)
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
      actual.set(key, section.id)
    }
  }
  const missing = [...expected.keys()].filter((key) => !counts.has(key)).sort()
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort()
  const unexpected = [...actual.keys()].filter((key) => !expected.has(key)).sort()
  const misplaced = [...actual.entries()]
    .filter(([key, section]) => expected.has(key) && expected.get(key) !== section)
    .map(([key]) => key)
    .sort()
  return { missing, duplicates, unexpected, misplaced }
}
