import { fuzzyMatch } from "./format.ts"

export const shortcutGroups: Array<{ title: string; entries: Array<[string, string]> }> = [
  { title: "Leader", entries: [["~", "Leader key"], ["~ ?", "This searchable help"], ["~ q", "Leave Ensemble"], ["Esc", "Cancel leader mode"]] },
  { title: "Navigation", entries: [["h / l", "Previous / next column"], ["j / k", "Next / previous item"], ["Enter", "Open selected chat"], ["i", "Focus composer"], ["Esc", "Leave composer"]] },
  { title: "Workspaces", entries: [["n", "New workspace"], ["g", "Edit members and leader"], ["w / W", "Next / previous workspace"], ["/", "Search workspaces"], ["p", "Pause or resume"], ["I", "Init Ensemble in this workspace"], ["Ctrl+W", "Archive workspace"], ["Ctrl+Shift+W", "Delete workspace"], ["Ctrl+Shift+Delete", "Reset Ensemble"]] },
  { title: "Chat", entries: [["$Name", "Mention an agent"], ["@path", "Reference a workspace file"], ["/command", "Ensemble commands"], ["PageUp / PageDown", "Scroll transcript"], ["End", "Jump to newest message"]] },
  { title: "Wizards", entries: [["Ctrl+P", "Previous step"], ["Ctrl+N", "Next step"], ["Enter", "Continue or submit"], ["Shift+Enter", "New line in a text field"], ["Esc", "Cancel the wizard"]] },
  { title: "Subtasks", entries: [["d", "Delegate"], ["t", "Reassign"], ["Enter", "Open result"], ["r", "Retry"], ["R", "Restart"], ["x", "Cancel"], ["o", "Open native session"]] },
  { title: "Agents", entries: [["a", "New agent"], ["z / Z", "Next / previous agent"], ["s", "Agent settings"], ["Ctrl+A", "Archive agent"], ["Ctrl+Shift+A", "Delete agent"]] },
  { title: "Settings", entries: [["Tab", "Cycle tab"], ["e", "Edit"], ["b", "Add backup"], ["Ctrl+↑ / Ctrl+↓", "Move backup"], ["Backspace", "Remove backup"], ["Ctrl+S", "Save"], ["Space", "Toggle skill"], ["Ctrl+F", "Filter skills"]] },
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

