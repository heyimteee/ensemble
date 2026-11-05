import test from "node:test"
import assert from "node:assert/strict"
import {
  HELP_SECTION_ORDER,
  filterHelpSections,
  helpCoverageIssues,
  helpEntryKey,
  helpMatchAfter,
  helpSections,
} from "./help.ts"
import { KEYMAP_CATALOG, normalEntries, statuslineHints } from "./keymap.ts"
import { COMMANDS } from "./commands.ts"
import { MOUSE_GESTURES } from "./mouse.ts"
import { resolveVimKey, resolveVisualKey } from "./vim.ts"

test("help opens as the spec's sections in the documented order", () => {
  assert.deepEqual(
    helpSections().map((section) => section.title),
    [
      "Modes and Esc ladder",
      "Global keys",
      "Roster",
      "Group chat and Direct conversation",
      "Work list",
      "Composer · Insert",
      "Composer · Normal",
      "Composer · Visual",
      "Settings",
      "Wizard",
      "Dialogs",
      "Command and search",
      "Leader menu",
      "Clipboard and mouse",
      "Statusline legend",
      "Native-session scope",
    ],
  )
  assert.deepEqual(
    HELP_SECTION_ORDER.map((section) => section.id),
    helpSections().map((section) => section.id),
  )
})

test("every catalog binding, command, and mouse gesture appears exactly once", () => {
  assert.deepEqual(helpCoverageIssues(), {
    missing: [],
    duplicates: [],
    unexpected: [],
    misplaced: [],
  })
})

test("the completeness checker catches omissions, duplicates, and invented entries", () => {
  const full = helpSections()
  const omitted = full.map((section) => ({
    ...section,
    entries: section.entries.filter((entry) => !(entry.source.kind === "keymap" && entry.source.id === "nav.down")),
  }))
  const missing = helpCoverageIssues({ sections: omitted })
  assert.ok(missing.missing.includes("keymap:roster:nav.down"), `missing: ${missing.missing.join(", ")}`)

  const duplicated = full.map((section) => {
    if (section.id !== "roster") return section
    const first = section.entries.find((entry) => entry.source.kind === "keymap")
    return first ? { ...section, entries: [...section.entries, first] } : section
  })
  const duplicates = helpCoverageIssues({ sections: duplicated })
  assert.ok(duplicates.duplicates.length > 0, "a repeated source is a duplicate")

  const invented = full.map((section) => {
    if (section.id !== "roster") return section
    return {
      ...section,
      entries: [
        ...section.entries,
        { id: "invented", keys: "F9", title: "Invented shortcut", source: { kind: "keymap" as const, id: "invented", context: "roster" as const } },
      ],
    }
  })
  const unexpected = helpCoverageIssues({ sections: invented })
  assert.ok(unexpected.unexpected.includes("keymap:roster:invented"), `unexpected: ${unexpected.unexpected.join(", ")}`)
})

test("catalog contexts land in the correct help section", () => {
  const expected: Record<string, string> = {
    global: "global",
    roster: "roster",
    chat: "conversation",
    work: "work",
    composerInsert: "composer-insert",
    composerNormal: "composer-normal",
    composerVisual: "composer-visual",
    completion: "composer-insert",
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
  }
  const sections = helpSections()
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.source.kind === "keymap" && entry.source.context !== "leader") {
        assert.equal(section.id, expected[entry.source.context], `${entry.source.id} belongs in ${expected[entry.source.context]}`)
      }
      if (entry.source.kind === "keymap" && entry.source.context === "leader") assert.equal(section.id, "leader")
      if (entry.source.kind === "command") assert.equal(section.id, "command")
      if (entry.source.kind === "mouse") assert.equal(section.id, "clipboard-mouse")
    }
  }
})

test("command names and mouse gestures are generated from their catalogs", () => {
  const sections = helpSections()
  const commandSection = sections.find((section) => section.id === "command")!
  for (const command of COMMANDS) {
    const matches = commandSection.entries.filter((entry) => entry.source.kind === "command" && entry.source.id === command.name)
    assert.equal(matches.length, 1, `:${command.name} appears once`)
    assert.equal(matches[0].keys, `:${command.name}`)
    assert.equal(matches[0].title, command.description)
  }
  const mouseSection = sections.find((section) => section.id === "clipboard-mouse")!
  for (const gesture of MOUSE_GESTURES) {
    const matches = mouseSection.entries.filter((entry) => entry.source.kind === "mouse" && entry.source.id === gesture.id)
    assert.equal(matches.length, 1, `${gesture.id} appears once`)
    assert.equal(matches[0].keys, gesture.gesture)
    assert.equal(matches[0].title, gesture.title)
  }
})

test("help retires stale hand-written Settings and wizard chords", () => {
  const keys = helpSections().flatMap((section) => section.entries.map((entry) => entry.keys))
  assert.ok(!keys.includes("Ctrl+F"), "the old skills filter key is gone")
  assert.ok(!keys.includes("Ctrl+P"), "the old memory promote key is gone")
  assert.ok(!keys.includes("Ctrl+N"), "the old wizard next key is gone")
  assert.ok(!keys.some((key) => key.includes("~")), "the tilde leader is retired")
  assert.ok(keys.includes("p"), "promote stays documented under the settings syntax")
})

test("help filtering is fuzzy and n/N wrap through matches", () => {
  const sections = helpSections()
  assert.deepEqual(filterHelpSections(sections, ""), sections)
  assert.deepEqual(filterHelpSections(sections, "zzz-no-shortcut"), [])
  const matches = filterHelpSections(sections, "delete workspace").flatMap((section) => section.entries)
  assert.ok(matches.some((entry) => entry.source.kind === "keymap" && entry.source.context === "leader" && entry.source.id === "leader.delete.workspace"))
  assert.equal(helpMatchAfter(3, 0, 1), 1)
  assert.equal(helpMatchAfter(3, 2, 1), 0)
  assert.equal(helpMatchAfter(3, 0, -1), 2)
  assert.equal(helpMatchAfter(0, 0, 1), 0)
})

test("help entry keys are stable per section", () => {
  const section = helpSections().find((candidate) => candidate.id === "roster")!
  const entry = section.entries[0]
  assert.equal(helpEntryKey(section, entry), `roster:${entry.id}`)
})

test("help overlay hints come from the same catalog as the overlay keys", () => {
  const hints = statuslineHints("help")
  for (const entry of normalEntries("help")) {
    if (entry.hint) assert.ok(hints.includes(entry.hint), `${entry.id} hint in ${hints}`)
  }
  assert.ok(hints.includes("/ filter"))
  assert.ok(hints.includes("n/N match"))
  assert.ok(hints.includes("esc close"))
})

test("the composer catalog is exactly the Vim resolver's Normal and Visual grammar", () => {
  const normal = normalEntries("composerNormal")
  const visual = normalEntries("composerVisual")
  const token = (value: string): string => value.startsWith("shift+") ? value.slice("shift+".length).toUpperCase() : value

  const resolveNormal = (keys: readonly string[]) => {
    if (keys.length === 1) return resolveVimKey("", token(keys[0]))
    if (keys[0] === "d" && keys[1] === "g") return resolveVimKey("dg", "g")
    if (keys[0] === "d") return resolveVimKey("d", token(keys[1]))
    if (keys[0] === "y" && keys[1] === "y") return resolveVimKey("y", "y")
    if (keys[0] === "g" && keys[1] === "g") return resolveVimKey("g", "g")
    return { type: "unhandled" as const }
  }
  const resolveVisual = (keys: readonly string[]) => {
    if (keys.length === 1) return resolveVisualKey("", token(keys[0]))
    if (keys[0] === "g" && keys[1] === "g") return resolveVisualKey("g", "g")
    return { type: "unhandled" as const }
  }

  const appLevel = new Set(["composerNormal.command", "composerNormal.search", "composerNormal.enter", "composerNormal.escape", "composerNormal.leave"])
  for (const entry of normal) {
    if (appLevel.has(entry.id)) continue
    const resolution = resolveNormal(entry.keys)
    const prefix = entry.keys.length === 1 && ["d", "y", "g"].includes(entry.keys[0])
    assert.ok(
      resolution.type === "command" || (prefix && resolution.type === "pending"),
      `composerNormal:${entry.id} resolves (${resolution.type})`,
    )
  }
  const visualAppLevel = new Set(["composerVisual.escape", "composerVisual.leave"])
  for (const entry of visual) {
    if (visualAppLevel.has(entry.id)) continue
    const resolution = resolveVisual(entry.keys)
    const prefix = entry.keys.length === 1 && entry.keys[0] === "g"
    assert.ok(
      resolution.type === "command" || (prefix && resolution.type === "pending"),
      `composerVisual:${entry.id} resolves (${resolution.type})`,
    )
  }

  const normalKeys = new Set(normal.map((entry) => entry.keys.join(" ")))
  const singleNormal = ["h", "j", "k", "l", "w", "b", "e", "0", "^", "$", "shift+g", "i", "a", "shift+i", "shift+a", "o", "shift+o", "v", "shift+v", "x", "shift+d", "d", "y", "g", "p", "shift+p", "u", "ctrl+r", "escape", "enter", "ctrl+g", ":", "/"]
  for (const key of singleNormal) assert.ok(normalKeys.has(key), `Normal ${key} is catalogued`)
  for (const motion of ["h", "j", "k", "l", "w", "b", "e", "0", "$", "shift+g"]) {
    assert.ok(normalKeys.has(`d ${motion}`), `delete motion ${motion} is catalogued`)
  }
  assert.ok(normalKeys.has("d d"))
  assert.ok(normalKeys.has("d g g"))
  assert.ok(normalKeys.has("y y"))
  assert.ok(normalKeys.has("g g"))

  const visualKeys = new Set(visual.map((entry) => entry.keys.join(" ")))
  const singleVisual = ["h", "j", "k", "l", "w", "b", "e", "0", "^", "$", "shift+g", "o", "y", "d", "x", "c", "p", "shift+p", "g", "v", "shift+v", "escape", "ctrl+g"]
  for (const key of singleVisual) assert.ok(visualKeys.has(key), `Visual ${key} is catalogued`)
  assert.ok(visualKeys.has("g g"))
})

test("help covers the special-case composer and text-field bindings", () => {
  const sections = helpSections()
  const sources = new Set(
    sections.flatMap((section) =>
      section.entries.flatMap((entry) =>
        entry.source.kind === "keymap" ? [`${entry.source.context}:${entry.source.id}`] : [],
      ),
    ),
  )
  for (const source of [
    "composerNormal:composerNormal.enter",
    "composerNormal:composerNormal.leave",
    "composerNormal:composerNormal.command",
    "composerNormal:composerNormal.search",
    "composerVisual:composerVisual.leave",
    "wizardField:wizardField.leave",
    "wizardText:wizardText.motion.h",
    "wizardText:wizardText.delete",
    "wizardText:wizardText.leave",
    "promptText:promptText.paste",
    "promptText:promptText.leave",
    "settingsField:settingsField.leave",
    "settingsText:settingsText.escape",
  ]) {
    assert.ok(sources.has(source), `help lists ${source}`)
  }
})
