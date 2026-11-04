import { fuzzyMatch } from "./format.ts"
import { isMacPlatform, platformLabel } from "./platform.ts"
import { WIZARD_NAV_LABELS } from "./wizard.ts"

/** Help keys that must not be rewritten to Cmd: the universal wizard pair. */
export function helpKeyLabel(key: string, mac = isMacPlatform()): string {
  if (key === WIZARD_NAV_LABELS.back || key === WIZARD_NAV_LABELS.next) return key
  return platformLabel(key, mac)
}

export const shortcutGroups: Array<{ title: string; entries: Array<[string, string]> }> = [
  { title: "Leader", entries: [["~", "Leader key"], ["~ ?", "This searchable help"], ["~ q", "Leave Ensemble"], ["Esc", "Cancel leader mode"]] },
  { title: "Navigation", entries: [["h / l", "Switch column"], ["j / k", "Rail item / work row"], ["Enter", "Open chat / work result"], ["i", "Focus composer"], ["Esc", "Leave composer"]] },
  { title: "Workspaces", entries: [["n", "New workspace"], ["g", "Edit members and leader"], ["w / W", "Next / previous workspace"], ["/", "Search workspaces"], ["p", "Pause or resume"], ["I", "Init workspace files (initialisation, not routing)"], ["Ctrl+W", "Archive workspace"], ["Ctrl+Shift+W", "Delete workspace"], ["Ctrl+Shift+Delete", "Reset Ensemble"]] },
  { title: "Chat", entries: [["$Name", "Mention an agent"], ["@path", "Reference a workspace file"], ["/command", "Ensemble commands"], ["PageUp / PageDown", "Scroll transcript"], ["End", "Jump to newest message"]] },
  { title: "Wizards", entries: [["Ctrl+P", "Previous step"], ["Ctrl+N", "Next step"], ["Enter", "Continue or submit"], ["Shift+Enter", "New line in a text field"], ["Esc", "Cancel the wizard"]] },
  { title: "Work", entries: [["d", "Delegate selected work"], ["t", "Reassign selected work"], ["Enter", "Open selected work result"], ["r", "Retry selected work"], ["R", "Restart selected work"], ["x", "Cancel selected work"], ["o", "Open native session"]] },
  { title: "Agents", entries: [["a", "New agent"], ["z / Z", "Next / previous agent"], ["s", "Agent settings"], ["Ctrl+A", "Archive agent"], ["Ctrl+Shift+A", "Delete agent"]] },
  { title: "Settings", entries: [["Tab", "Cycle tab"], ["e", "Edit"], ["n", "New memory"], ["b", "Add backup"], ["Shift+↑ / Shift+↓", "Move backup"], ["Backspace", "Remove backup"], ["s", "Save"], ["Space", "Toggle skill"], ["PageUp / PageDown", "Skill page"], ["Ctrl+F", "Filter skills"], ["Ctrl+D", "Delete memory"], ["Ctrl+P", "Promote memory"], ["/", "Filter memories"]] },
]

export function helpGroups(query: string): Array<{ title: string; entries: Array<[string, string]> }> {
  const needle = query.trim().toLowerCase()
  if (!needle) return shortcutGroups
  return shortcutGroups
    .map((group) => ({
      title: group.title,
      entries: group.entries.filter((entry) => fuzzyMatch(needle, `${group.title} ${entry[0]} ${entry[1]}`)),
    }))
    .filter((group) => group.entries.length > 0)
}

