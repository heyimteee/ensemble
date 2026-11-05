/**
 * v5.6 shared Normal grammar (ticket #81).
 *
 * One declarative catalog is the source of truth for the generated keymap
 * layers, the statusline hints, and the Space which-key popup. Later tickets
 * add their contexts and leader actions here instead of growing per-surface
 * key handler lists. v5.6 T6 reuses the same grammar for wizards and dialogs:
 * their surface keys and text-field footer hints are catalog entries, and the
 * app resolves them through the one chord machine. Keys are canonical tokens
 * (lower-case names, `shift+x`, `ctrl+d`, named keys) so one pure resolver
 * serves raw keypresses and the host keymap alike.
 */

export type KeyContext =
  | "roster"
  | "chat"
  | "work"
  | "composer"
  | "settings"
  /** Wizard list step: j/k, gg/G, Enter, Space multi-select, /, Esc back. */
  | "wizard"
  /** Wizard text field in Insert mode: Enter continues, Esc goes to field Normal. */
  | "wizardField"
  /** Wizard text field in Normal mode: the Vim subset plus continue/back. */
  | "wizardText"
  /** Single or multi-choice picker overlay. */
  | "picker"
  /** Text prompt in Insert mode. */
  | "promptField"
  /** Text prompt in Normal mode. */
  | "promptText"
  | "confirm"
  | "result"
  | "approvals"
  | "filter"
  | "help"
  /** Bindings available from any Normal surface, outside every overlay. */
  | "global"
  /** The `:`/`/` input row: run, cancel, history, completion, editing. */
  | "command"
  /** Committed transcript search: n/N move, Esc clears. */
  | "search"
  /** Composer completion popup (Up/Down/Enter/Esc). */
  | "completion"
  /** Composer text buffer, Insert mode. */
  | "composerInsert"
  /** Composer text buffer, Normal mode: the shared Vim subset. */
  | "composerNormal"
  /** Composer text buffer, Visual mode: char or line selection. */
  | "composerVisual"

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
  requires?: "work" | "multi"
  /** The binding is unavailable while one of these transient modes is active. */
  availability?: "no-transcript-search"
  /** Hide from which-key and compact statusline hints; help still lists it. */
  listed?: boolean
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
  // `d` is contextual: delegate here, never the text-buffer delete operator.
  { id: "work.delegate", scope: "normal", contexts: ["work"], keys: ["d"], title: "Delegate work", group: "Work", hint: "d delegate" },
  { id: "work.reassign", scope: "normal", contexts: ["work"], keys: ["t"], title: "Reassign work", group: "Work", hint: "t reassign" },
  { id: "work.retry", scope: "normal", contexts: ["work"], keys: ["r"], title: "Retry work", group: "Work", hint: "r retry" },
  { id: "work.restart", scope: "normal", contexts: ["work"], keys: ["shift+r"], title: "Restart work", group: "Work", hint: "R restart" },
  { id: "work.cancel", scope: "normal", contexts: ["work"], keys: ["x"], title: "Cancel work", group: "Work", hint: "x cancel" },
  { id: "work.native", scope: "normal", contexts: ["work"], keys: ["o"], title: "Native session", group: "Navigate", hint: "o native" },
  { id: "focus.tab", scope: "normal", contexts: ["work"], keys: ["tab"], title: "Transcript", group: "Focus", hint: "tab chat" },
  { id: "leader", scope: "normal", contexts: ["work"], keys: ["space"], title: "Leader menu", group: "Leader", hint: "space leader" },
  { id: "escape", scope: "normal", contexts: ["work"], keys: ["escape"], title: "Back to transcript", group: "Navigation", listed: false },

  // Settings ---------------------------------------------------------------
  { id: "settings.tab.prev", scope: "normal", contexts: ["settings"], keys: ["h"], title: "Previous tab", group: "Tabs", hint: "h/l tabs" },
  { id: "settings.tab.next", scope: "normal", contexts: ["settings"], keys: ["l"], title: "Next tab", group: "Tabs" },
  { id: "settings.tab.cycle", scope: "normal", contexts: ["settings"], keys: ["tab"], title: "Next tab", group: "Tabs" },
  { id: "settings.tab.cycle.prev", scope: "normal", contexts: ["settings"], keys: ["shift+tab"], title: "Previous tab", group: "Tabs" },
  { id: "settings.down", scope: "normal", contexts: ["settings"], keys: ["j"], title: "Next row", group: "Navigation", hint: "j/k rows" },
  { id: "settings.up", scope: "normal", contexts: ["settings"], keys: ["k"], title: "Previous row", group: "Navigation" },
  { id: "settings.top", scope: "normal", contexts: ["settings"], keys: ["g", "g"], title: "First row", group: "Navigation", listed: false },
  { id: "settings.bottom", scope: "normal", contexts: ["settings"], keys: ["shift+g"], title: "Last row", group: "Navigation", listed: false },
  { id: "settings.edit", scope: "normal", contexts: ["settings"], keys: ["enter"], title: "Edit or toggle row", group: "Edit", hint: "enter edit" },
  { id: "settings.edit.alt", scope: "normal", contexts: ["settings"], keys: ["e"], title: "Edit row", group: "Edit" },
  { id: "settings.add", scope: "normal", contexts: ["settings"], keys: ["a"], title: "Add row", group: "Create", hint: "a add" },
  { id: "settings.delete", scope: "normal", contexts: ["settings"], keys: ["x"], title: "Delete row", group: "Delete", hint: "x delete" },
  { id: "settings.backup.down", scope: "normal", contexts: ["settings"], keys: ["shift+j"], title: "Move backup down", group: "Reorder", hint: "J/K reorder" },
  { id: "settings.backup.up", scope: "normal", contexts: ["settings"], keys: ["shift+k"], title: "Move backup up", group: "Reorder" },
  { id: "settings.promote", scope: "normal", contexts: ["settings"], keys: ["p"], title: "Promote memory", group: "Edit", hint: "p promote" },
  { id: "settings.toggle", scope: "normal", contexts: ["settings"], keys: ["space"], title: "Toggle skill", group: "Edit", hint: "space toggle" },
  { id: "settings.save", scope: "normal", contexts: ["settings"], keys: ["s"], title: "Save settings", group: "State", hint: "s save" },
  { id: "settings.filter", scope: "normal", contexts: ["settings"], keys: ["/"], title: "Filter tab", group: "Search", hint: "/ filter" },
  { id: "settings.escape", scope: "normal", contexts: ["settings"], keys: ["escape"], title: "Close settings", group: "Navigation", hint: "esc close" },
]

/**
 * Wizard list steps reuse the Normal list grammar. `Space` only toggles on a
 * multi-select step; `:` and the leader are absent by construction, so a
 * wizard can never open the command line or the which-key menu.
 */
const WIZARD: readonly KeyEntry[] = [
  { id: "wizard.down", scope: "normal", contexts: ["wizard"], keys: ["j"], title: "Next option", group: "Navigation", hint: "j/k move" },
  { id: "wizard.up", scope: "normal", contexts: ["wizard"], keys: ["k"], title: "Previous option", group: "Navigation" },
  { id: "wizard.down.arrow", scope: "normal", contexts: ["wizard"], keys: ["down"], title: "Next option", group: "Navigation", listed: false },
  { id: "wizard.up.arrow", scope: "normal", contexts: ["wizard"], keys: ["up"], title: "Previous option", group: "Navigation", listed: false },
  { id: "wizard.top", scope: "normal", contexts: ["wizard"], keys: ["g", "g"], title: "First option", group: "Navigation", listed: false },
  { id: "wizard.bottom", scope: "normal", contexts: ["wizard"], keys: ["shift+g"], title: "Last option", group: "Navigation", listed: false },
  { id: "wizard.activate", scope: "normal", contexts: ["wizard"], keys: ["enter"], title: "Select or continue", group: "Open", hint: "enter next" },
  { id: "wizard.toggle", scope: "normal", contexts: ["wizard"], keys: ["space"], title: "Toggle option", group: "Select", hint: "space toggle", requires: "multi" },
  { id: "wizard.filter", scope: "normal", contexts: ["wizard"], keys: ["/"], title: "Filter options", group: "Search", hint: "/ filter" },
  { id: "wizard.back", scope: "normal", contexts: ["wizard"], keys: ["escape"], title: "Back one step or cancel", group: "Navigation", hint: "esc back" },
]

/**
 * Dialogs share the list grammar; only the resolving key and the cancel
 * wording differ per surface. Confirm accepts y/Enter and rejects n/Esc;
 * results and approvals scroll before they resolve.
 */
const DIALOG: readonly KeyEntry[] = [
  // Picker ----------------------------------------------------------------
  { id: "picker.down", scope: "normal", contexts: ["picker"], keys: ["j"], title: "Next item", group: "Navigation", hint: "j/k move" },
  { id: "picker.up", scope: "normal", contexts: ["picker"], keys: ["k"], title: "Previous item", group: "Navigation" },
  { id: "picker.down.arrow", scope: "normal", contexts: ["picker"], keys: ["down"], title: "Next item", group: "Navigation", listed: false },
  { id: "picker.up.arrow", scope: "normal", contexts: ["picker"], keys: ["up"], title: "Previous item", group: "Navigation", listed: false },
  { id: "picker.top", scope: "normal", contexts: ["picker"], keys: ["g", "g"], title: "First item", group: "Navigation", listed: false },
  { id: "picker.bottom", scope: "normal", contexts: ["picker"], keys: ["shift+g"], title: "Last item", group: "Navigation", listed: false },
  { id: "picker.activate", scope: "normal", contexts: ["picker"], keys: ["enter"], title: "Select", group: "Open", hint: "enter select" },
  { id: "picker.toggle", scope: "normal", contexts: ["picker"], keys: ["space"], title: "Toggle item", group: "Select", hint: "space toggle", requires: "multi" },
  { id: "picker.filter", scope: "normal", contexts: ["picker"], keys: ["/"], title: "Filter items", group: "Search", hint: "/ filter" },
  { id: "picker.cancel", scope: "normal", contexts: ["picker"], keys: ["escape"], title: "Cancel", group: "Navigation", hint: "esc cancel" },

  // Confirm ---------------------------------------------------------------
  { id: "confirm.accept", scope: "normal", contexts: ["confirm"], keys: ["y"], title: "Yes", group: "Decision", hint: "y/enter yes" },
  { id: "confirm.accept.enter", scope: "normal", contexts: ["confirm"], keys: ["enter"], title: "Yes", group: "Decision", listed: false },
  { id: "confirm.reject", scope: "normal", contexts: ["confirm"], keys: ["n"], title: "No", group: "Decision", hint: "n/esc no" },
  { id: "confirm.reject.escape", scope: "normal", contexts: ["confirm"], keys: ["escape"], title: "No", group: "Decision", listed: false },

  // Result ----------------------------------------------------------------
  { id: "result.down", scope: "normal", contexts: ["result"], keys: ["j"], title: "Scroll down", group: "Scroll", hint: "j/k scroll" },
  { id: "result.up", scope: "normal", contexts: ["result"], keys: ["k"], title: "Scroll up", group: "Scroll" },
  { id: "result.down.arrow", scope: "normal", contexts: ["result"], keys: ["down"], title: "Scroll down", group: "Scroll", listed: false },
  { id: "result.up.arrow", scope: "normal", contexts: ["result"], keys: ["up"], title: "Scroll up", group: "Scroll", listed: false },
  { id: "result.top", scope: "normal", contexts: ["result"], keys: ["g", "g"], title: "Top of result", group: "Scroll", listed: false },
  { id: "result.bottom", scope: "normal", contexts: ["result"], keys: ["shift+g"], title: "Bottom of result", group: "Scroll", listed: false },
  { id: "result.half.down", scope: "normal", contexts: ["result"], keys: ["ctrl+d"], title: "Half page down", group: "Scroll", hint: "ctrl+d/u page" },
  { id: "result.half.up", scope: "normal", contexts: ["result"], keys: ["ctrl+u"], title: "Half page up", group: "Scroll" },
  { id: "result.page.down", scope: "normal", contexts: ["result"], keys: ["pagedown"], title: "Page down", group: "Scroll", listed: false },
  { id: "result.page.up", scope: "normal", contexts: ["result"], keys: ["pageup"], title: "Page up", group: "Scroll", listed: false },
  { id: "result.close.enter", scope: "normal", contexts: ["result"], keys: ["enter"], title: "Close", group: "Navigation", listed: false },
  { id: "result.close.escape", scope: "normal", contexts: ["result"], keys: ["escape"], title: "Close", group: "Navigation", hint: "enter/esc close" },

  // Approvals -------------------------------------------------------------
  { id: "approvals.down", scope: "normal", contexts: ["approvals"], keys: ["j"], title: "Next approval", group: "Navigation", hint: "j/k move" },
  { id: "approvals.up", scope: "normal", contexts: ["approvals"], keys: ["k"], title: "Previous approval", group: "Navigation" },
  { id: "approvals.down.arrow", scope: "normal", contexts: ["approvals"], keys: ["down"], title: "Next approval", group: "Navigation", listed: false },
  { id: "approvals.up.arrow", scope: "normal", contexts: ["approvals"], keys: ["up"], title: "Previous approval", group: "Navigation", listed: false },
  { id: "approvals.top", scope: "normal", contexts: ["approvals"], keys: ["g", "g"], title: "First approval", group: "Navigation", listed: false },
  { id: "approvals.bottom", scope: "normal", contexts: ["approvals"], keys: ["shift+g"], title: "Last approval", group: "Navigation", listed: false },
  { id: "approvals.resolve", scope: "normal", contexts: ["approvals"], keys: ["enter"], title: "Resolve", group: "Open", hint: "enter resolve" },
  { id: "approvals.close", scope: "normal", contexts: ["approvals"], keys: ["escape"], title: "Close", group: "Navigation", hint: "esc close" },
]

/**
 * Text fields are edited by the shared Vim adapter (#85); their catalog
 * entries exist so the statusline teaches the same Esc ladder everywhere.
 * They are hint-only: the app routes keys through the editor, not the layer.
 */
const TEXT_FIELDS: readonly KeyEntry[] = [
  { id: "wizardField.submit", scope: "normal", contexts: ["wizardField"], keys: ["enter"], title: "Continue", group: "Text", hint: "enter next" },
  { id: "wizardField.normal", scope: "normal", contexts: ["wizardField"], keys: ["escape"], title: "Field Normal", group: "Text", hint: "esc normal" },
  { id: "wizardText.submit", scope: "normal", contexts: ["wizardText"], keys: ["enter"], title: "Continue", group: "Text", hint: "enter next" },
  { id: "wizardText.insert", scope: "normal", contexts: ["wizardText"], keys: ["i"], title: "Insert", group: "Text", hint: "i/a insert" },
  { id: "wizardText.insert.alt", scope: "normal", contexts: ["wizardText"], keys: ["a"], title: "Insert", group: "Text", listed: false },
  { id: "wizardText.motion", scope: "normal", contexts: ["wizardText"], keys: ["h"], title: "Move cursor", group: "Text", hint: "h/j/k/l move" },
  { id: "wizardText.back", scope: "normal", contexts: ["wizardText"], keys: ["escape"], title: "Back one step", group: "Text", hint: "esc back" },
  { id: "promptField.submit", scope: "normal", contexts: ["promptField"], keys: ["enter"], title: "Submit", group: "Text", hint: "enter submit" },
  { id: "promptField.newline", scope: "normal", contexts: ["promptField"], keys: ["shift+enter"], title: "New line", group: "Text", hint: "shift+enter newline" },
  { id: "promptField.normal", scope: "normal", contexts: ["promptField"], keys: ["escape"], title: "Field Normal", group: "Text", hint: "esc normal" },
  { id: "promptText.submit", scope: "normal", contexts: ["promptText"], keys: ["enter"], title: "Submit", group: "Text", hint: "enter submit" },
  { id: "promptText.insert", scope: "normal", contexts: ["promptText"], keys: ["i"], title: "Insert", group: "Text", hint: "i/a insert" },
  { id: "promptText.insert.alt", scope: "normal", contexts: ["promptText"], keys: ["a"], title: "Insert", group: "Text", listed: false },
  { id: "promptText.motion", scope: "normal", contexts: ["promptText"], keys: ["h"], title: "Move cursor", group: "Text", hint: "h/j/k/l move" },
  { id: "promptText.cancel", scope: "normal", contexts: ["promptText"], keys: ["escape"], title: "Cancel", group: "Text", hint: "esc cancel" },
  { id: "filter.edit", scope: "normal", contexts: ["filter"], keys: ["backspace"], title: "Type to filter", group: "Search", hint: "type to filter" },
  { id: "filter.done", scope: "normal", contexts: ["filter"], keys: ["enter"], title: "Finish filtering", group: "Search", hint: "enter done" },
  { id: "filter.cancel", scope: "normal", contexts: ["filter"], keys: ["escape"], title: "Clear filter", group: "Search", hint: "esc clear" },
]

/**
 * Global help and native-return bindings live outside every surface context.
 * They are catalog entries even though the host plugin owns F2 and the raw
 * Normal handler owns `?`, so help can never invent a binding.
 */
const GLOBAL: readonly KeyEntry[] = [
  { id: "global.help", scope: "normal", contexts: ["global"], keys: ["?"], title: "Open help", group: "Global", hint: "? help" },
  { id: "global.native", scope: "normal", contexts: ["global"], keys: ["f2"], title: "Open Ensemble from a native session", group: "Global" },
]

/** Help overlay grammar: the same dialog grammar used by every other list. */
const HELP_KEYS: readonly KeyEntry[] = [
  { id: "help.down", scope: "normal", contexts: ["help"], keys: ["j"], title: "Scroll down", group: "Navigation", hint: "j/k scroll" },
  { id: "help.up", scope: "normal", contexts: ["help"], keys: ["k"], title: "Scroll up", group: "Navigation" },
  { id: "help.half.down", scope: "normal", contexts: ["help"], keys: ["ctrl+d"], title: "Half page down", group: "Navigation", hint: "ctrl+d/u page" },
  { id: "help.half.up", scope: "normal", contexts: ["help"], keys: ["ctrl+u"], title: "Half page up", group: "Navigation" },
  { id: "help.top", scope: "normal", contexts: ["help"], keys: ["g", "g"], title: "Top of help", group: "Navigation", hint: "gg/G top/bottom" },
  { id: "help.bottom", scope: "normal", contexts: ["help"], keys: ["shift+g"], title: "Bottom of help", group: "Navigation" },
  { id: "help.filter", scope: "normal", contexts: ["help"], keys: ["/"], title: "Filter help", group: "Search", hint: "/ filter" },
  { id: "help.match.next", scope: "normal", contexts: ["help"], keys: ["n"], title: "Next match", group: "Search", hint: "n/N match" },
  { id: "help.match.prev", scope: "normal", contexts: ["help"], keys: ["shift+n"], title: "Previous match", group: "Search" },
  { id: "help.close", scope: "normal", contexts: ["help"], keys: ["escape"], title: "Close help", group: "Navigation", hint: "esc close" },
]

/** The `:`/`/` row is a text input, but its grammar is catalogued too. */
const COMMAND_KEYS: readonly KeyEntry[] = [
  { id: "command.run", scope: "normal", contexts: ["command"], keys: ["enter"], title: "Run command or search", group: "Command", hint: "enter run" },
  { id: "command.cancel", scope: "normal", contexts: ["command"], keys: ["escape"], title: "Cancel and restore the previous filter", group: "Command", hint: "esc cancel" },
  { id: "command.history.up", scope: "normal", contexts: ["command"], keys: ["up"], title: "Recall an older entry", group: "History", hint: "↑↓ history" },
  { id: "command.history.down", scope: "normal", contexts: ["command"], keys: ["down"], title: "Recall a newer entry", group: "History" },
  { id: "command.complete", scope: "normal", contexts: ["command"], keys: ["tab"], title: "Complete the command name", group: "Command", hint: "tab complete" },
  { id: "command.backspace", scope: "normal", contexts: ["command"], keys: ["backspace"], title: "Delete the previous character", group: "Editing" },
]

/** Committed transcript search: n/N cycle matches, Esc clears. */
const SEARCH_KEYS: readonly KeyEntry[] = [
  { id: "search.next", scope: "normal", contexts: ["search"], keys: ["n"], title: "Next match", group: "Search", hint: "n next" },
  { id: "search.prev", scope: "normal", contexts: ["search"], keys: ["shift+n"], title: "Previous match", group: "Search", hint: "N previous" },
  { id: "search.clear", scope: "normal", contexts: ["search"], keys: ["escape"], title: "Clear the committed search", group: "Search", hint: "esc clear" },
]

/** Composer completion popup; Up/Down stay literal in the text buffer. */
const COMPLETION_KEYS: readonly KeyEntry[] = [
  { id: "completion.previous", scope: "normal", contexts: ["completion"], keys: ["up"], title: "Previous completion", group: "Completion", hint: "↑/↓ select" },
  { id: "completion.next", scope: "normal", contexts: ["completion"], keys: ["down"], title: "Next completion", group: "Completion" },
  { id: "completion.accept", scope: "normal", contexts: ["completion"], keys: ["enter"], title: "Accept the completion", group: "Completion", hint: "enter insert" },
  { id: "completion.close", scope: "normal", contexts: ["completion"], keys: ["escape"], title: "Close the completion popup", group: "Completion", hint: "esc close" },
]

/**
 * The shared text-buffer grammar (#85/#86) is catalogued alongside every
 * list binding: Composer Insert, Normal, and Visual are the same engine used
 * by settings, wizard, and prompt text fields. The Vim resolver remains the
 * executor; the catalog is the single help/statusline source of truth.
 */
const COMPOSER: readonly KeyEntry[] = [
  // Insert ----------------------------------------------------------------
  { id: "composerInsert.enter", scope: "normal", contexts: ["composerInsert"], keys: ["enter"], title: "Send message", group: "Insert", hint: "enter send" },
  { id: "composerInsert.newline", scope: "normal", contexts: ["composerInsert"], keys: ["shift+enter"], title: "Insert a new line", group: "Insert", hint: "shift+enter newline" },
  { id: "composerInsert.escape", scope: "normal", contexts: ["composerInsert"], keys: ["escape"], title: "Go to composer Normal", group: "Insert", hint: "esc normal" },
  { id: "composerInsert.stop", scope: "normal", contexts: ["composerInsert"], keys: ["ctrl+c"], title: "Stop running work", group: "Insert", hint: "ctrl+c stop" },
  { id: "composerInsert.leave", scope: "normal", contexts: ["composerInsert"], keys: ["ctrl+g"], title: "Leave the composer immediately", group: "Insert", hint: "ctrl+g leave" },
  { id: "composerInsert.mention", scope: "normal", contexts: ["composerInsert"], keys: ["$"], title: "Open agent mentions", group: "Completion", hint: "$ agent" },
  { id: "composerInsert.file", scope: "normal", contexts: ["composerInsert"], keys: ["@"], title: "Open file references", group: "Completion", hint: "@ file" },
  { id: "composerInsert.slash", scope: "normal", contexts: ["composerInsert"], keys: ["/"], title: "Run a slash command", group: "Completion", hint: "/ command" },

  // Normal: motions --------------------------------------------------------
  { id: "composerNormal.motion.h", scope: "normal", contexts: ["composerNormal"], keys: ["h"], title: "Move left", group: "Motion" },
  { id: "composerNormal.motion.j", scope: "normal", contexts: ["composerNormal"], keys: ["j"], title: "Move down", group: "Motion" },
  { id: "composerNormal.motion.k", scope: "normal", contexts: ["composerNormal"], keys: ["k"], title: "Move up", group: "Motion" },
  { id: "composerNormal.motion.l", scope: "normal", contexts: ["composerNormal"], keys: ["l"], title: "Move right", group: "Motion" },
  { id: "composerNormal.motion.w", scope: "normal", contexts: ["composerNormal"], keys: ["w"], title: "Next word", group: "Motion" },
  { id: "composerNormal.motion.b", scope: "normal", contexts: ["composerNormal"], keys: ["b"], title: "Previous word", group: "Motion" },
  { id: "composerNormal.motion.e", scope: "normal", contexts: ["composerNormal"], keys: ["e"], title: "End of word", group: "Motion" },
  { id: "composerNormal.motion.0", scope: "normal", contexts: ["composerNormal"], keys: ["0"], title: "Line start", group: "Motion" },
  { id: "composerNormal.motion.caret", scope: "normal", contexts: ["composerNormal"], keys: ["^"], title: "First non-blank character", group: "Motion" },
  { id: "composerNormal.motion.lineEnd", scope: "normal", contexts: ["composerNormal"], keys: ["$"], title: "Line end", group: "Motion" },
  { id: "composerNormal.motion.gg", scope: "normal", contexts: ["composerNormal"], keys: ["g", "g"], title: "Buffer start", group: "Motion" },
  { id: "composerNormal.motion.G", scope: "normal", contexts: ["composerNormal"], keys: ["shift+g"], title: "Buffer end", group: "Motion" },

  // Normal: insert entries ------------------------------------------------
  { id: "composerNormal.insert.i", scope: "normal", contexts: ["composerNormal"], keys: ["i"], title: "Insert before the cursor", group: "Insert", hint: "i insert" },
  { id: "composerNormal.insert.a", scope: "normal", contexts: ["composerNormal"], keys: ["a"], title: "Insert after the cursor", group: "Insert" },
  { id: "composerNormal.insert.I", scope: "normal", contexts: ["composerNormal"], keys: ["shift+i"], title: "Insert at line start", group: "Insert" },
  { id: "composerNormal.insert.A", scope: "normal", contexts: ["composerNormal"], keys: ["shift+a"], title: "Insert at line end", group: "Insert" },
  { id: "composerNormal.insert.o", scope: "normal", contexts: ["composerNormal"], keys: ["o"], title: "Open a line below", group: "Insert" },
  { id: "composerNormal.insert.O", scope: "normal", contexts: ["composerNormal"], keys: ["shift+o"], title: "Open a line above", group: "Insert" },

  // Normal: edit operators ------------------------------------------------
  { id: "composerNormal.delete", scope: "normal", contexts: ["composerNormal"], keys: ["d"], title: "Delete operator (then a motion, d, or gg)", group: "Edit", hint: "x/d edit" },
  { id: "composerNormal.yank", scope: "normal", contexts: ["composerNormal"], keys: ["y"], title: "Yank operator (yy)", group: "Edit" },
  { id: "composerNormal.prefix.g", scope: "normal", contexts: ["composerNormal"], keys: ["g"], title: "Chord prefix (gg)", group: "Edit" },
  { id: "composerNormal.x", scope: "normal", contexts: ["composerNormal"], keys: ["x"], title: "Delete the character", group: "Edit" },
  { id: "composerNormal.dd", scope: "normal", contexts: ["composerNormal"], keys: ["d", "d"], title: "Delete the line", group: "Edit" },
  { id: "composerNormal.D", scope: "normal", contexts: ["composerNormal"], keys: ["shift+d"], title: "Delete to the line end", group: "Edit" },
  { id: "composerNormal.dh", scope: "normal", contexts: ["composerNormal"], keys: ["d", "h"], title: "Delete left", group: "Edit" },
  { id: "composerNormal.dj", scope: "normal", contexts: ["composerNormal"], keys: ["d", "j"], title: "Delete down", group: "Edit" },
  { id: "composerNormal.dk", scope: "normal", contexts: ["composerNormal"], keys: ["d", "k"], title: "Delete up", group: "Edit" },
  { id: "composerNormal.dl", scope: "normal", contexts: ["composerNormal"], keys: ["d", "l"], title: "Delete right", group: "Edit" },
  { id: "composerNormal.dw", scope: "normal", contexts: ["composerNormal"], keys: ["d", "w"], title: "Delete the next word", group: "Edit" },
  { id: "composerNormal.db", scope: "normal", contexts: ["composerNormal"], keys: ["d", "b"], title: "Delete the previous word", group: "Edit" },
  { id: "composerNormal.de", scope: "normal", contexts: ["composerNormal"], keys: ["d", "e"], title: "Delete to the word end", group: "Edit" },
  { id: "composerNormal.d0", scope: "normal", contexts: ["composerNormal"], keys: ["d", "0"], title: "Delete to the line start", group: "Edit" },
  { id: "composerNormal.d$", scope: "normal", contexts: ["composerNormal"], keys: ["d", "$"], title: "Delete to the line end", group: "Edit" },
  { id: "composerNormal.dgg", scope: "normal", contexts: ["composerNormal"], keys: ["d", "g", "g"], title: "Delete to the buffer start", group: "Edit" },
  { id: "composerNormal.dG", scope: "normal", contexts: ["composerNormal"], keys: ["d", "shift+g"], title: "Delete to the buffer end", group: "Edit" },
  { id: "composerNormal.undo", scope: "normal", contexts: ["composerNormal"], keys: ["u"], title: "Undo", group: "Edit" },
  { id: "composerNormal.redo", scope: "normal", contexts: ["composerNormal"], keys: ["ctrl+r"], title: "Redo", group: "Edit" },

  // Normal: yank, paste, visual, leave -----------------------------------
  { id: "composerNormal.yy", scope: "normal", contexts: ["composerNormal"], keys: ["y", "y"], title: "Yank the line", group: "Yank", hint: "yy/p yank" },
  { id: "composerNormal.paste", scope: "normal", contexts: ["composerNormal"], keys: ["p"], title: "Paste after the cursor", group: "Paste" },
  { id: "composerNormal.paste.before", scope: "normal", contexts: ["composerNormal"], keys: ["shift+p"], title: "Paste before the cursor", group: "Paste" },
  { id: "composerNormal.visual", scope: "normal", contexts: ["composerNormal"], keys: ["v"], title: "Start character Visual", group: "Visual" },
  { id: "composerNormal.visual.line", scope: "normal", contexts: ["composerNormal"], keys: ["shift+v"], title: "Start line Visual", group: "Visual" },
  { id: "composerNormal.escape", scope: "normal", contexts: ["composerNormal"], keys: ["escape"], title: "Go to chat Normal", group: "Navigation", hint: "esc chat" },

  // Visual: motions extend the selection ---------------------------------
  { id: "composerVisual.motion.h", scope: "normal", contexts: ["composerVisual"], keys: ["h"], title: "Extend left", group: "Motion" },
  { id: "composerVisual.motion.j", scope: "normal", contexts: ["composerVisual"], keys: ["j"], title: "Extend down", group: "Motion" },
  { id: "composerVisual.motion.k", scope: "normal", contexts: ["composerVisual"], keys: ["k"], title: "Extend up", group: "Motion" },
  { id: "composerVisual.motion.l", scope: "normal", contexts: ["composerVisual"], keys: ["l"], title: "Extend right", group: "Motion" },
  { id: "composerVisual.motion.w", scope: "normal", contexts: ["composerVisual"], keys: ["w"], title: "Extend to the next word", group: "Motion" },
  { id: "composerVisual.motion.b", scope: "normal", contexts: ["composerVisual"], keys: ["b"], title: "Extend to the previous word", group: "Motion" },
  { id: "composerVisual.motion.e", scope: "normal", contexts: ["composerVisual"], keys: ["e"], title: "Extend to the word end", group: "Motion" },
  { id: "composerVisual.motion.0", scope: "normal", contexts: ["composerVisual"], keys: ["0"], title: "Extend to the line start", group: "Motion" },
  { id: "composerVisual.motion.caret", scope: "normal", contexts: ["composerVisual"], keys: ["^"], title: "Extend to the first non-blank", group: "Motion" },
  { id: "composerVisual.motion.lineEnd", scope: "normal", contexts: ["composerVisual"], keys: ["$"], title: "Extend to the line end", group: "Motion" },
  { id: "composerVisual.motion.gg", scope: "normal", contexts: ["composerVisual"], keys: ["g", "g"], title: "Extend to the buffer start", group: "Motion" },
  { id: "composerVisual.motion.G", scope: "normal", contexts: ["composerVisual"], keys: ["shift+g"], title: "Extend to the buffer end", group: "Motion" },
  { id: "composerVisual.prefix.g", scope: "normal", contexts: ["composerVisual"], keys: ["g"], title: "Chord prefix (gg)", group: "Motion" },

  // Visual: selection actions --------------------------------------------
  { id: "composerVisual.swap", scope: "normal", contexts: ["composerVisual"], keys: ["o"], title: "Swap the selection ends", group: "Selection" },
  { id: "composerVisual.yank", scope: "normal", contexts: ["composerVisual"], keys: ["y"], title: "Copy the selection", group: "Selection", hint: "y copy" },
  { id: "composerVisual.delete", scope: "normal", contexts: ["composerVisual"], keys: ["d"], title: "Cut the selection", group: "Selection", hint: "d cut" },
  { id: "composerVisual.delete.x", scope: "normal", contexts: ["composerVisual"], keys: ["x"], title: "Cut the selection", group: "Selection" },
  { id: "composerVisual.change", scope: "normal", contexts: ["composerVisual"], keys: ["c"], title: "Cut the selection and insert", group: "Selection", hint: "c change" },
  { id: "composerVisual.paste", scope: "normal", contexts: ["composerVisual"], keys: ["p"], title: "Replace the selection with the clipboard", group: "Selection", hint: "p paste" },
  { id: "composerVisual.paste.before", scope: "normal", contexts: ["composerVisual"], keys: ["shift+p"], title: "Replace the selection with the clipboard", group: "Selection" },
  { id: "composerVisual.leave", scope: "normal", contexts: ["composerVisual"], keys: ["v"], title: "Leave Visual", group: "Navigation", hint: "esc cancel" },
  { id: "composerVisual.line", scope: "normal", contexts: ["composerVisual"], keys: ["shift+v"], title: "Switch to line selection", group: "Selection" },
  { id: "composerVisual.escape", scope: "normal", contexts: ["composerVisual"], keys: ["escape"], title: "Leave Visual", group: "Navigation" },
]

export const KEYMAP_CATALOG: readonly KeyEntry[] = [
  ...NORMAL,
  ...LEADER,
  ...WIZARD,
  ...DIALOG,
  ...TEXT_FIELDS,
  ...GLOBAL,
  ...HELP_KEYS,
  ...COMMAND_KEYS,
  ...SEARCH_KEYS,
  ...COMPOSER,
  ...COMPLETION_KEYS,
]

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

/** Global Normal bindings (`?` help, F2 native return). */
export function globalEntries(): readonly KeyEntry[] {
  return KEYMAP_CATALOG.filter((entry) => entry.scope === "normal" && entry.contexts.includes("global"))
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
export function statuslineHints(
  context: KeyContext,
  options: {
    hasWork?: boolean
    multiple?: boolean
    filter?: (entry: KeyEntry) => boolean
  } = {},
): string {
  const hasWork = options.hasWork ?? true
  const multiple = options.multiple ?? false
  return normalEntries(context)
    .filter((entry) => options.filter?.(entry) ?? true)
    .flatMap((entry) => {
      if (entry.listed === false) return []
      if (entry.requires === "multi" && !multiple) return []
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
  delete: "Delete",
  up: "Up",
  down: "Down",
  "?": "?",
}

export function keyLabel(keys: readonly string[]): string {
  if (keys.length === 0) return ""
  if (keys.length > 1 && keys.every((key) => /^[a-z]$/.test(key))) return keys.join("")
  return keys.map(labelForKey).join(" ")
}

/**
 * Vim-style chord label: single-character tokens join without a space
 * (`gg`, `dG`, `d$`); named tokens keep their readable spacing.
 */
export function keyChordLabel(keys: readonly string[]): string {
  if (keys.length === 0) return ""
  const labels = keys.map(labelForKey)
  return labels.every((label) => label.length === 1) ? labels.join("") : labels.join(" ")
}

function labelForKey(key: string): string {
  const named = NAMED_KEY_LABELS[key]
  if (named) return named
  if (key.startsWith("shift+")) {
    const rest = key.slice("shift+".length)
    return /^[a-z]$/.test(rest) ? rest.toUpperCase() : `Shift+${labelForKey(rest)}`
  }
  if (key.startsWith("ctrl+")) return `Ctrl+${modifierLabel(key.slice("ctrl+".length))}`
  if (key.startsWith("super+")) return `Cmd+${modifierLabel(key.slice("super+".length))}`
  if (key.startsWith("alt+")) return `Alt+${modifierLabel(key.slice("alt+".length))}`
  if (/^f\d+$/.test(key)) return key.toUpperCase()
  return key
}

/** Modifier children read as terminal keys: `Ctrl+D`, `Shift+G`. */
function modifierLabel(key: string): string {
  if (key.startsWith("shift+")) return `Shift+${modifierLabel(key.slice("shift+".length))}`
  const label = labelForKey(key)
  return label.length === 1 ? label.toUpperCase() : label
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
  if (name === "return" || name === "enter" || name === "kpenter" || sequence === "\r" || sequence === "\n") return event?.shift ? "shift+enter" : "enter"
  if (name === "escape") return "escape"
  if (name === "tab") return event?.shift ? "shift+tab" : "tab"
  // The terminal's keyboard protocol can reset after a native session: some
  // hosts then report Shift+; as `;` with a colon sequence, or as `;` with
  // only the Shift modifier. Normalize every shape to the command key.
  if (name === ":" || name === "colon" || sequence === ":") return ":"
  if ((name === ";" || name === "semicolon") && event?.shift) return ":"
  if (name === "backspace" || name === "pageup" || name === "pagedown" || name === "end" || name === "home") return name
  if (name === "?" || sequence === "?") return "?"
  if (name.startsWith("ctrl+") || name.startsWith("super+") || name.startsWith("alt+")) return name.toLowerCase()
  if (event?.ctrl && name.length === 1) return `ctrl+${name.toLowerCase()}`
  if ((event?.super || event?.meta) && name.length === 1) return `super+${name.toLowerCase()}`
  if (/^[A-Z]$/.test(name) || (event?.shift && /^[a-z]$/.test(name))) return `shift+${name.toLowerCase()}`
  if (name.length === 1) return name
  return sequence.length === 1 ? sequence : name
}
