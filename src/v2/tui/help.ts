import { fuzzyMatch } from "./format.ts"
import { isMacPlatform, platformLabel } from "./platform.ts"

/** Help keys that must not be rewritten to Cmd: transcript paging stays universal. */
export function helpKeyLabel(key: string, mac = isMacPlatform()): string {
  if (key === "Ctrl+D / Ctrl+U") return key
  return platformLabel(key, mac)
}

export const shortcutGroups: Array<{ title: string; entries: Array<[string, string]> }> = [
  { title: "Leader", entries: [["Space", "Leader key (which-key menu)"], ["Space ?", "This searchable help"], ["Space q", "Leave Ensemble"], ["Esc", "Cancel leader mode"]] },
  { title: "Roster", entries: [["j / k", "Move the rail selection"], ["g g / G", "First / last item"], ["Enter", "Open Workspace or Agent and focus the composer"], ["h / l", "Switch column"], ["/", "Filter the rail"], ["a", "New agent"], ["e", "Edit the selected item"], ["s", "Agent settings"], ["x / X", "Archive / delete the selected item"], ["Tab", "Move focus to the chat"]] },
  { title: "Group chat and Direct conversation", entries: [["j / k", "Scroll the transcript by line"], ["Ctrl+D / Ctrl+U", "Half page down / up"], ["g g / G", "First / last message"], ["Enter / i", "Focus the composer in Insert"], ["Tab", "Move between transcript and work list"], ["/", "Search the loaded transcript"], ["h / l", "Switch column"], ["PageUp / PageDown", "Scroll a page"], ["End", "Jump to newest message"]] },
  { title: "Navigation", entries: [["Esc", "Go up one level; never quits"], ["Ctrl+G", "Leave the composer (works while a run is active)"], ["Enter", "Open or act on the focused item"], ["F2", "Open Ensemble from any session"]] },
  { title: "Workspaces", entries: [["n", "New workspace"], ["w / W", "Next / previous workspace"], ["p", "Pause or resume"], ["I", "Init workspace files (initialisation, not routing)"], ["Ctrl+W", "Archive workspace"], ["Ctrl+Shift+W", "Delete workspace"], ["Ctrl+Shift+Delete", "Reset Ensemble"]] },
  { title: "Chat", entries: [["$Name", "Mention an agent"], ["@path", "Reference a workspace file"], ["/command", "Ensemble commands"], ["F2", "Open Ensemble from any session"]] },
  { title: "Wizards", entries: [["j / k", "Next / previous option"], ["g g / G", "First / last option"], ["Enter", "Select, continue, or submit"], ["Space", "Toggle a multi-select option"], ["/", "Filter the options"], ["Esc", "Field Normal, previous step, or cancel"], ["Shift+Enter", "New line in a text field"]] },
  { title: "Dialogs", entries: [["j / k", "Move in a list"], ["g g / G", "First / last row"], ["Enter", "Select, submit, resolve, or close"], ["Space", "Toggle a picker item"], ["/", "Filter picker or wizard options"], ["y / n", "Yes or no in a confirm"], ["Esc", "Clear filter, leave field, or cancel"], ["PgUp / PgDn", "Scroll a result"]] },
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

