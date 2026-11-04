/**
 * v5.6 shared Normal grammar (ticket #81).
 *
 * One declarative catalog is the source of truth for the generated keymap
 * layers, the statusline hints, and the Space which-key popup. Later tickets
 * add their contexts and leader actions here instead of growing per-surface
 * key handler lists. Keys are canonical tokens (lower-case names, `shift+x`,
 * `ctrl+d`, named keys) so one pure resolver serves raw keypresses and the
 * host keymap alike.
 */

export type KeyContext =
  | "roster"
  | "chat"
  | "work"
  | "composer"
  | "settings"
  | "wizard"
  | "dialog"
  | "approvals"
  | "help"

/** List surfaces use Normal grammar; the leader is a second scope over them. */
export type KeyScope = "normal" | "leader"

export type KeyEntry = {
  id: string
  scope: KeyScope
  contexts: readonly KeyContext[]
  /** Ordered chord keys; a single token is a direct binding. */
  keys: readonly string[]
  title: string
  group: string
  /** Compact statusline hint for the entries that teach the surface. */
  hint?: string
  /** Hint used when the work zone has no rows. */
  emptyHint?: string
  /** The binding only applies while the inline work list has rows. */
  requires?: "work"
  /** The binding is unavailable while one of these transient modes is active. */
  availability?: "no-transcript-search"
  /** Hide from which-key/help listings (chords, Esc, and plumbing). */
  listed?: boolean
  /** Legacy Ctrl binding that keeps the existing macOS Ctrl->Cmd transform. */
  platform?: boolean
}

const SURFACES: readonly KeyContext[] = ["roster", "chat", "work"]

const LEADER: readonly KeyEntry[] = [
  { id: "leader.help", scope: "leader", contexts: SURFACES, keys: ["?"], title: "Help", group: "Leader" },
  { id: "leader.leave", scope: "leader", contexts: SURFACES, keys: ["q"], title: "Leave Ensemble", group: "Leader" },
  { id: "leader.cancel", scope: "leader", contexts: SURFACES, keys: ["escape"], title: "Cancel", group: "Leader" },
  { id: "leader.new.agent", scope: "leader", contexts: SURFACES, keys: ["a"], title: "New agent", group: "Create" },
  { id: "leader.new.workspace", scope: "leader", contexts: SURFACES, keys: ["n"], title: "New workspace", group: "Create" },
  { id: "leader.edit.workspace", scope: "leader", contexts: SURFACES, keys: ["e"], title: "Edit workspace", group: "Edit" },
  { id: "leader.settings", scope: "leader", contexts: SURFACES, keys: ["s"], title: "Settings", group: "Edit" },
  { id: "leader.archive.workspace", scope: "leader", contexts: SURFACES, keys: ["w"], title: "Archive workspace", group: "Archive" },
  { id: "leader.delete.workspace", scope: "leader", contexts: SURFACES, keys: ["shift+w"], title: "Delete workspace", group: "Delete" },
  { id: "leader.archive.agent", scope: "leader", contexts: SURFACES, keys: ["shift+a"], title: "Archive agent", group: "Archive" },
  { id: "leader.delete.agent", scope: "leader", contexts: SURFACES, keys: ["shift+d"], title: "Delete agent", group: "Delete" },
  { id: "leader.approvals", scope: "leader", contexts: SURFACES, keys: ["v"], title: "Approvals", group: "Navigate" },
  { id: "leader.pause", scope: "leader", contexts: SURFACES, keys: ["p"], title: "Pause / resume", group: "State" },
  { id: "leader.init", scope: "leader", contexts: SURFACES, keys: ["i"], title: "Init workspace files", group: "State" },
  { id: "leader.native", scope: "leader", contexts: SURFACES, keys: ["o"], title: "Native session", group: "Navigate" },
  { id: "leader.delegate", scope: "leader", contexts: SURFACES, keys: ["d"], title: "Delegate", group: "Work" },
  { id: "leader.reassign", scope: "leader", contexts: SURFACES, keys: ["t"], title: "Reassign", group: "Work" },
  { id: "leader.retry", scope: "leader", contexts: SURFACES, keys: ["r"], title: "Retry", group: "Work" },
  { id: "leader.restart", scope: "leader", contexts: SURFACES, keys: ["shift+r"], title: "Restart", group: "Work" },
  { id: "leader.cancel.task", scope: "leader", contexts: SURFACES, keys: ["x"], title: "Cancel work", group: "Work" },
]

/**
 * Roster and both conversation surfaces share the same j/k, gg/G, h/l,
 * Enter, Tab, /, and Space grammar. Chat/roster-specific entries are kept
 * separate so a later ticket can replace one surface without rewriting the
 * catalog.
 */
const NORMAL: readonly KeyEntry[] = [
  // Roster -----------------------------------------------------------------
  { id: "nav.down", scope: "normal", contexts: ["roster"], keys: ["j"], title: "Move down", group: "Navigation", hint: "j/k move" },
  { id: "nav.up", scope: "normal", contexts: ["roster"], keys: ["k"], title: "Move up", group: "Navigation" },
  { id: "nav.top", scope: "normal", contexts: ["roster"], keys: ["g", "g"], title: "First item", group: "Navigation", listed: false },
  { id: "nav.bottom", scope: "normal", contexts: ["roster"], keys: ["shift+g"], title: "Last item", group: "Navigation", listed: false },
  { id: "nav.left", scope: "normal", contexts: ["roster"], keys: ["h"], title: "Rail column", group: "Focus", hint: "h/l column" },
  { id: "nav.right", scope: "normal", contexts: ["roster"], keys: ["l"], title: "Chat column", group: "Focus" },
  { id: "focus.tab", scope: "normal", contexts: ["roster"], keys: ["tab"], title: "Chat column", group: "Focus", hint: "tab chat" },
  { id: "open", scope: "normal", contexts: ["roster"], keys: ["enter"], title: "Open and compose", group: "Open", hint: "enter open" },
  { id: "new.agent", scope: "normal", contexts: ["roster"], keys: ["a"], title: "New agent", group: "Create" },
  { id: "new.workspace", scope: "normal", contexts: ["roster"], keys: ["n"], title: "New workspace", group: "Create" },
  { id: "edit", scope: "normal", contexts: ["roster"], keys: ["e"], title: "Edit selection", group: "Edit" },
  { id: "settings", scope: "normal", contexts: ["roster"], keys: ["s"], title: "Agent settings", group: "Edit" },
  { id: "archive", scope: "normal", contexts: ["roster"], keys: ["x"], title: "Archive selection", group: "Archive" },
  { id: "delete", scope: "normal", contexts: ["roster"], keys: ["shift+x"], title: "Delete selection", group: "Delete" },
  { id: "approvals", scope: "normal", contexts: ["roster"], keys: ["v"], title: "Approvals", group: "Navigate" },
  { id: "init", scope: "normal", contexts: ["roster"], keys: ["shift+i"], title: "Init workspace files", group: "State", hint: "I init" },
  { id: "pause", scope: "normal", contexts: ["roster"], keys: ["p"], title: "Pause / resume workspace", group: "State" },
  { id: "filter", scope: "normal", contexts: ["roster"], keys: ["/"], title: "Filter roster", group: "Search", hint: "/ filter" },
  { id: "leader", scope: "normal", contexts: ["roster"], keys: ["space"], title: "Leader menu", group: "Leader", hint: "space leader" },
  { id: "escape", scope: "normal", contexts: ["roster"], keys: ["escape"], title: "Clear filter", group: "Navigation", listed: false },

  // Group chat and Direct conversation -------------------------------------
  { id: "chat.scroll.down", scope: "normal", contexts: ["chat"], keys: ["j"], title: "Scroll transcript down", group: "Scroll", hint: "j/k scroll" },
  { id: "chat.scroll.up", scope: "normal", contexts: ["chat"], keys: ["k"], title: "Scroll transcript up", group: "Scroll" },
  { id: "chat.top", scope: "normal", contexts: ["chat"], keys: ["g", "g"], title: "First message", group: "Scroll", listed: false },
  { id: "chat.bottom", scope: "normal", contexts: ["chat"], keys: ["shift+g"], title: "Last message", group: "Scroll", listed: false },
  { id: "chat.half.down", scope: "normal", contexts: ["chat"], keys: ["ctrl+d"], title: "Half page down", group: "Scroll", hint: "ctrl+d/u page" },
  { id: "chat.half.up", scope: "normal", contexts: ["chat"], keys: ["ctrl+u"], title: "Half page up", group: "Scroll" },
  { id: "chat.nav.left", scope: "normal", contexts: ["chat"], keys: ["h"], title: "Rail column", group: "Focus", hint: "h/l column" },
  { id: "chat.nav.right", scope: "normal", contexts: ["chat"], keys: ["l"], title: "Chat column", group: "Focus" },
  { id: "focus.tab", scope: "normal", contexts: ["chat"], keys: ["tab"], title: "Work list", group: "Focus", hint: "tab work", emptyHint: "tab rail", requires: "work" },
  { id: "compose", scope: "normal", contexts: ["chat"], keys: ["enter"], title: "Compose", group: "Open", hint: "enter/i compose" },
  { id: "compose.alt", scope: "normal", contexts: ["chat"], keys: ["i"], title: "Compose", group: "Open" },
  { id: "chat.new.agent", scope: "normal", contexts: ["chat"], keys: ["a"], title: "New agent", group: "Create" },
  { id: "chat.new.workspace", scope: "normal", contexts: ["chat"], keys: ["n"], title: "New workspace", group: "Create", availability: "no-transcript-search" },
  { id: "chat.settings", scope: "normal", contexts: ["chat"], keys: ["s"], title: "Agent settings", group: "Edit" },
  { id: "chat.approvals", scope: "normal", contexts: ["chat"], keys: ["v"], title: "Approvals", group: "Navigate" },
  { id: "chat.init", scope: "normal", contexts: ["chat"], keys: ["shift+i"], title: "Init workspace files", group: "State", hint: "I init" },
  { id: "chat.pause", scope: "normal", contexts: ["chat"], keys: ["p"], title: "Pause / resume workspace", group: "State" },
  { id: "chat.native", scope: "normal", contexts: ["chat"], keys: ["o"], title: "Native session", group: "Navigate" },
  { id: "chat.cancel", scope: "normal", contexts: ["chat"], keys: ["x"], title: "Cancel selected work or remove queued message", group: "Work" },
  { id: "chat.filter", scope: "normal", contexts: ["chat"], keys: ["/"], title: "Search transcript", group: "Search", hint: "/ search" },
  { id: "leader", scope: "normal", contexts: ["chat"], keys: ["space"], title: "Leader menu", group: "Leader", hint: "space leader" },
  { id: "chat.workspace.next", scope: "normal", contexts: ["chat"], keys: ["w"], title: "Next workspace", group: "Navigate" },
  { id: "chat.workspace.prev", scope: "normal", contexts: ["chat"], keys: ["shift+w"], title: "Previous workspace", group: "Navigate" },
  { id: "chat.agent.next", scope: "normal", contexts: ["chat"], keys: ["z"], title: "Next agent", group: "Navigate" },
  { id: "chat.agent.prev", scope: "normal", contexts: ["chat"], keys: ["shift+z"], title: "Previous agent", group: "Navigate" },
  { id: "chat.page.up", scope: "normal", contexts: ["chat"], keys: ["pageup"], title: "Page transcript up", group: "Scroll", listed: false },
  { id: "chat.page.down", scope: "normal", contexts: ["chat"], keys: ["pagedown"], title: "Page transcript down", group: "Scroll", listed: false },
  { id: "chat.page.bottom", scope: "normal", contexts: ["chat"], keys: ["end"], title: "Jump to newest message", group: "Scroll", listed: false },
  { id: "escape", scope: "normal", contexts: ["chat"], keys: ["escape"], title: "Clear search", group: "Navigation", listed: false },

  // Work list zone ---------------------------------------------------------
  { id: "work.down", scope: "normal", contexts: ["work"], keys: ["j"], title: "Next work row", group: "Navigation", hint: "j/k move" },
  { id: "work.up", scope: "normal", contexts: ["work"], keys: ["k"], title: "Previous work row", group: "Navigation" },
  { id: "work.top", scope: "normal", contexts: ["work"], keys: ["g", "g"], title: "First work row", group: "Navigation", listed: false },
  { id: "work.bottom", scope: "normal", contexts: ["work"], keys: ["shift+g"], title: "Last work row", group: "Navigation", listed: false },
  { id: "work.open", scope: "normal", contexts: ["work"], keys: ["enter"], title: "Open work result", group: "Open", hint: "enter result" },
  { id: "focus.tab", scope: "normal", contexts: ["work"], keys: ["tab"], title: "Transcript", group: "Focus", hint: "tab chat" },
  { id: "leader", scope: "normal", contexts: ["work"], keys: ["space"], title: "Leader menu", group: "Leader", hint: "space leader" },
  { id: "escape", scope: "normal", contexts: ["work"], keys: ["escape"], title: "Back to transcript", group: "Navigation", listed: false },

  // Legacy Ctrl/agent/workspace actions remain available on the list
  // surfaces until later phase tickets move them to their own contexts.
  { id: "legacy.workspace.archive", scope: "normal", contexts: ["roster", "chat"], keys: ["ctrl+w"], title: "Archive workspace", group: "Legacy", listed: false, platform: true },
  { id: "legacy.workspace.delete", scope: "normal", contexts: ["roster", "chat"], keys: ["ctrl+shift+w"], title: "Delete workspace", group: "Legacy", listed: false, platform: true },
  { id: "legacy.agent.archive", scope: "normal", contexts: ["roster", "chat"], keys: ["ctrl+a"], title: "Archive agent", group: "Legacy", listed: false, platform: true },
  { id: "legacy.agent.delete", scope: "normal", contexts: ["roster", "chat"], keys: ["ctrl+shift+a"], title: "Delete agent", group: "Legacy", listed: false, platform: true },
  { id: "legacy.reset", scope: "normal", contexts: ["roster", "chat"], keys: ["ctrl+shift+delete"], title: "Reset Ensemble", group: "Legacy", listed: false, platform: true },
]

export const KEYMAP_CATALOG: readonly KeyEntry[] = [...NORMAL, ...LEADER]

export type KeyActionResolution = { type: "action"; entry: KeyEntry }
export type KeyPendingResolution = { type: "pending"; prefix: readonly string[]; entries: readonly KeyEntry[] }
export type KeyNoneResolution = { type: "none" }
export type KeyResolution = KeyActionResolution | KeyPendingResolution | KeyNoneResolution

export function normalEntries(context: KeyContext): readonly KeyEntry[] {
  return KEYMAP_CATALOG.filter((entry) => entry.scope === "normal" && entry.contexts.includes(context))
}

export function leaderEntries(): readonly KeyEntry[] {
  return KEYMAP_CATALOG.filter((entry) => entry.scope === "leader")
}

export function layerEntries(context: KeyContext): readonly KeyEntry[] {
  return normalEntries(context).filter((entry) => entry.keys.length === 1)
}

export function leaderLayerEntries(): readonly KeyEntry[] {
  return leaderEntries().filter((entry) => entry.keys.length === 1)
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

function isPrefix(prefix: readonly string[], keys: readonly string[]): boolean {
  return prefix.length < keys.length && prefix.every((key, index) => key === keys[index])
}

/**
 * Resolve one canonical key token against a context's Normal catalog. A
 * pending prefix that no longer matches falls back to the fresh single-key
 * binding for that token, so an accidental `g` never swallows the next key.
 */
export function resolveNormalKey(context: KeyContext, pending: readonly string[], token: string): KeyResolution {
  const entries = normalEntries(context)
  const sequence = [...pending, token]
  const exact = entries.find((entry) => sameKeys(entry.keys, sequence))
  if (exact) return { type: "action", entry: exact }
  const continuations = entries.filter((entry) => isPrefix(sequence, entry.keys))
  if (continuations.length > 0) return { type: "pending", prefix: sequence, entries: continuations }
  if (pending.length > 0) {
    const fresh = entries.find((entry) => entry.keys.length === 1 && entry.keys[0] === token)
    if (fresh) return { type: "action", entry: fresh }
  }
  return { type: "none" }
}

/** Leader keys are a single chord level; no further pending state exists. */
export function resolveLeaderKey(token: string): KeyResolution {
  const entry = leaderEntries().find((candidate) => candidate.keys.length === 1 && candidate.keys[0] === token)
  return entry ? { type: "action", entry } : { type: "none" }
}

export type DuplicateBinding = { scope: KeyScope; context: string; keys: string; ids: string[] }

/** Every (scope, context, key sequence) pair binds at most one action. */
export function duplicateBindings(catalog: readonly KeyEntry[] = KEYMAP_CATALOG): DuplicateBinding[] {
  const seen = new Map<string, string[]>()
  for (const entry of catalog) {
    const contexts = entry.scope === "leader" ? ["leader"] : entry.contexts
    for (const context of contexts) {
      const key = `${entry.scope}|${context}|${entry.keys.join(" ")}`
      const ids = seen.get(key) ?? []
      ids.push(entry.id)
      seen.set(key, ids)
    }
  }
  return [...seen.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => {
      const [scope, context, keys] = key.split("|")
      return { scope: scope as KeyScope, context, keys, ids }
    })
}

/**
 * Statusline hints are generated from the same catalog that drives the
 * layers; only teaching entries carry a hint, so the bar stays short.
 */
export function statuslineHints(context: KeyContext, options: { hasWork?: boolean } = {}): string {
  const hasWork = options.hasWork ?? true
  return normalEntries(context)
    .flatMap((entry) => {
      if (entry.listed === false) return []
      const hint = entry.requires === "work" && !hasWork ? entry.emptyHint : entry.hint
      return hint ? [hint] : []
    })
    .filter((hint, index, all) => all.indexOf(hint) === index)
    .join(" · ")
}

const NAMED_KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  pageup: "PageUp",
  pagedown: "PageDown",
  end: "End",
  home: "Home",
  "?": "?",
}

export function keyLabel(keys: readonly string[]): string {
  if (keys.length === 0) return ""
  if (keys.length > 1 && keys.every((key) => /^[a-z]$/.test(key))) return keys.join("")
  return keys.map(labelForKey).join(" ")
}

function labelForKey(key: string): string {
  const named = NAMED_KEY_LABELS[key]
  if (named) return named
  if (key.startsWith("shift+")) {
    const rest = key.slice("shift+".length)
    return /^[a-z]$/.test(rest) ? rest.toUpperCase() : `Shift+${labelForKey(rest)}`
  }
  if (key.startsWith("ctrl+")) return `Ctrl+${labelForKey(key.slice("ctrl+".length))}`
  if (key.startsWith("super+")) return `Cmd+${labelForKey(key.slice("super+".length))}`
  if (key.startsWith("alt+")) return `Alt+${labelForKey(key.slice("alt+".length))}`
  return key.length === 1 ? key.toUpperCase() : key
}

/**
 * Which-key rows: column-major cells so a short list reads top-to-bottom in
 * each column. Pure text; the popup only adds the border.
 */
export function whichKeyLines(entries: readonly KeyEntry[], columns = 2): string[] {
  const listed = entries.filter((entry) => entry.listed !== false)
  if (listed.length === 0) return []
  const columnCount = Math.max(1, Math.min(columns, listed.length))
  const rows = Math.ceil(listed.length / columnCount)
  const width = 28
  const lines: string[] = []
  for (let row = 0; row < rows; row++) {
    const cells: string[] = []
    for (let column = 0; column < columnCount; column++) {
      const entry = listed[row + column * rows]
      if (!entry) continue
      const cell = `${keyLabel(entry.keys)} ${entry.title}`
      cells.push(column < columnCount - 1 ? cell.padEnd(width) : cell)
    }
    const line = cells.join("").trimEnd()
    if (line) lines.push(line)
  }
  return lines
}

/**
 * Normalize a raw OpenTUI keypress into the catalog's canonical token. Named
 * keys win over modifiers; printable keys keep their actual case so `/`, `?`,
 * and `G` can be bound.
 */
export function normalizeKeyToken(event: {
  name?: string
  sequence?: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
} | undefined): string {
  const name = String(event?.name ?? "")
  const sequence = String(event?.sequence ?? "")
  if (name === "space" || sequence === " ") return "space"
  if (name === "return" || name === "enter" || name === "kpenter" || sequence === "\r" || sequence === "\n") return "enter"
  if (name === "escape") return "escape"
  if (name === "tab") return event?.shift ? "shift+tab" : "tab"
  if (name === "backspace" || name === "pageup" || name === "pagedown" || name === "end" || name === "home") return name
  if (name === "?" || sequence === "?") return "?"
  if (name.startsWith("ctrl+") || name.startsWith("super+") || name.startsWith("alt+")) return name.toLowerCase()
  if (event?.ctrl && name.length === 1) return `ctrl+${name.toLowerCase()}`
  if ((event?.super || event?.meta) && name.length === 1) return `super+${name.toLowerCase()}`
  if (/^[A-Z]$/.test(name) || (event?.shift && /^[a-z]$/.test(name))) return `shift+${name.toLowerCase()}`
  if (name.length === 1) return name
  return sequence.length === 1 ? sequence : name
}
