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
  settingsMemoryField: "settings",
  settingsMemoryText: "settings",
  wizard: "wizard",
  wizardField: "wizard",
  wizardText: "wizard",
  wizardMemory: "wizard",
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

function info(id: string, keys: string, title: string): HelpEntry {
  return { id, keys, title, source: { kind: "info", id: `info.${id}` } }
}

/** Prose rows that explain policy rather than duplicate a key binding. */
const INFO_ENTRIES: Readonly<Record<HelpSectionID, readonly HelpEntry[]>> = {
  modes: [
    info("mode.normal", "NORMAL", "Lists navigate rows; text buffers run the Vim subset."),
    info("mode.insert", "INSERT", "Type into the focused composer or text field."),
    info("mode.visual", "VISUAL / V-LINE", "Select text by character or line, then yank, cut, or change."),
    info("mode.command", "COMMAND", "The : command line or the / search/filter input."),
    info("mode.persistent", "mode", "Mode is global and persistent: focus, overlay, wizard-step, and surface changes never assign it; Enter never changes it. Only explicit mode keys do."),
    info("mode.caret", "caret", "Every text editor shows a block caret in Normal and a line caret in Insert, Visual, and Command; an unfocused editor shows none."),
    info("escape.insert", "Esc", "Insert → Normal (composer or text field)."),
    info("escape.visual", "Esc", "Visual → Normal."),
    info("escape.composer", "Esc", "Composer Normal → chat Normal."),
    info("escape.settings.field", "Esc", "Settings text field Normal → settings Normal."),
    info("escape.settings", "Esc", "Settings Normal → close settings."),
    info("escape.wizard.field", "Esc", "Wizard text field Insert → field Normal; field Normal → cancel the wizard (a dirty draft asks first)."),
    info("escape.wizard", "Esc", "Wizard step Normal → cancel the wizard. n next and N previous move between steps; Enter advances."),
    info("escape.dialog", "Esc", "Cancel the dialog, picker, confirm, result, or approval inbox."),
    info("escape.command", "Esc", "Command → Normal, restoring the previous filter."),
    info("escape.chat", "Esc", "Clear a filter or committed search; otherwise a no-op."),
    info("escape.never", "Esc", "Esc never leaves Ensemble. Quit deliberately with :q or Space q."),
    info("escape.ctrl-g", "Ctrl+G", "Leave the focused composer, settings, wizard, or prompt text field immediately when the host consumes Esc."),
  ],
  global: [
    info("focus.zones", "Tab / Shift+Tab", "Move focus zones between the roster, transcript, and work list. Enter the composer with i or Enter, not Tab."),
    info("esc", "Esc", "Go up one level. The full ladder is in Modes and Esc ladder."),
    info("quit", ":q / Space q", "Leave Ensemble deliberately; no other key quits."),
  ],
  roster: [
    info("destructive", "x / X", "x archives; X deletes and asks for confirmation."),
  ],
  conversation: [
    info("no-cursor", "j / k", "Scroll the transcript by line; there is no message cursor."),
  ],
  work: [
    info("context", "d", "Delegates in the work list; inside a text buffer d is the delete operator."),
  ],
  "composer-insert": [
    info("typing", "text", "Type at the cursor. Enter sends and keeps Insert focus; Shift+Enter adds a line."),
    info("composer.skill-palette", "/", "At message start / lists commands plus every skill with Command, Skill | General, or Skill | <Owner> flags; after $Agent / it lists only that agent's assigned skills."),
    info("composer.general-triage", "General", "A General skill has no Skillbox owner; it routes to the leader for triage. A General skill under a non-leader mention is rejected with the leader's name so the Skillbox stays authoritative."),
    info("composer.init-solo", "/init", "Init is solo-only and workspace-only: send /init by itself. It appends a visible System Agent job, streams progress and a report, and never falls through to native /init."),
    info("composer.skill-delivery", "exact text", "Each addressed agent receives the exact text once per message; multiple skills for one agent group into one prompt, no per-skill bodies or tasks are created, and separate messages keep their order."),
    info("composer.skill-validation", "validation", "Invalid skill or agent references reject the whole message before work starts, name the exact skill and owner, and keep the draft."),
  ],
  "composer-normal": [
    info("subset", "Vim subset", "No counts, text objects, macros, marks, or extra registers."),
  ],
  "composer-visual": [
    info("extend", "motions", "Motions extend the selection; o swaps its ends."),
  ],
  settings: [
    info("text", "Insert / Normal / Visual", "Text fields use the composer grammar; Esc returns to the settings rows, and Ctrl+G leaves the field directly."),
    info("settings.memory", "a / e / Enter", "Memory add/edit uses the same persistent field: Enter saves, an add clears for the next entry, an edit keeps its text, and the field stays focused."),
  ],
  wizard: [
    info("text", "Insert / Normal / Visual", "Text fields use the composer grammar; Esc goes to field Normal, and another Esc cancels (dirty asks first). Ctrl+G leaves the field immediately."),
    info("wizard.memory", "a / e / x", "Memories are an ordered list: a adds, e edits, x deletes, j/k selects, and n/N move between steps. Enter saves one memory and keeps the field focused for the next."),
  ],
  dialogs: [
    info("shared", "", "Pickers, prompts, confirms, results, and approvals share one grammar: j/k, Enter, Space, /, Esc."),
  ],
  command: [
    info("scope", ":", "Commands navigate or change state only; destructive actions stay on keys and the leader with their confirms."),
    info("command.edit", "←/→ Home/End", "The : and / input keeps a cursor: Left/Right, Home/End, Backspace, Delete, and insertion at the cursor all edit in place; history and Tab completion still apply."),
  ],
  leader: [
    info("space", "Space", "Leader key opens the which-key menu; Esc cancels it."),
  ],
  "clipboard-mouse": [
    info("yank", "y / yy", "Yank to the system clipboard."),
    info("cut", "d / dd / x", "Deletes are cuts and also write to the system clipboard."),
    info("paste", "p / P", "Read the system clipboard first; the internal register is the fallback."),
    info("visual", "Visual y / d / c", "Yank, cut, or change the selected range."),
    info("async", "async", "A paste is discarded if focus or the buffer changed while the clipboard read was in flight."),
    info("toast", "toast", "Copy success clears a mouse selection; failure keeps it and shows an error."),
  ],
  statusline: [
    info("mode", "mode", "Chip: NORMAL, INSERT, VISUAL, V-LINE, or COMMAND."),
    info("context", "context", "Roster, Group chat, Direct conversation, Work list, Settings, Wizard, Dialog, Approvals, or Help."),
    info("git", "git:(branch*)", "Branch, dirty mark, ahead ↑, and behind ↓ counts."),
    info("position", "position", "line:col in a text buffer, row/total in a list, or percent in the transcript."),
    info("chord", "chord", "Pending multi-key prefix, e.g. g."),
    info("hints", "hints", "Context keys generated from the binding catalog, e.g. enter open │ / filter │ space leader."),
    info("statusline.separators", "│", "Chrome joins segments with a faint │ and one space; ASCII | is the fallback. Chat message content is never rewritten."),
    info("statusline.badge", "LEADER", "The LEADER rail badge is a true cutout on an opaque surface; when no surface is guaranteed, black/white contrast is chosen from the accent."),
    info("row2", "row 2", ": or / input while active; otherwise the latest transient message; otherwise blank."),
  ],
  native: [
    info("scope", "", "Native-session keys are owned by the host; a hidden Ensemble page never consumes them."),
    info("native.quit", "quit / F2", "Leaving Ensemble hides the page; native keys, including /, go to the host immediately. F2 returns to Ensemble."),
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
